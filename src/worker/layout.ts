import {
  ATTR_CAP,
  F_CYCLE,
  F_DEGENERATE,
  F_ERROR,
  F_HAS_LOG,
  F_ORPHAN,
  F_ROOT,
  LAYOUT_FAILURE_COPY,
  LAYOUT_PROTOCOL_VERSION,
  LOG_CAP,
  SPAN_CAP,
  layoutBuffer,
  layoutViews,
  type LayoutFailure,
  type LayoutRequest,
  type LayoutResponse,
  type LayoutSummary,
  type LogAttr,
  type LogRecord,
  type LogUnattached,
  type LogValueKind,
} from "../shared/protocol";

/**
 * Trace flattening: OTLP JSON text in, positioned rows out. Separate from `layout.worker.ts` (four
 * lines of `onmessage`) so every decision here is a node test against a fixture rather than
 * something only observable through `postMessage`.
 *
 * **Nothing is repaired silently.** A mid-ingest trace from a partly broken system is the normal
 * reason someone opened this panel, not an exceptional case:
 *
 * ```
 *   parent absent from the response   ──▶  depth 0, F_ORPHAN
 *   parent chain reaches itself       ──▶  link cut at the repeat, F_CYCLE
 *   end <= start                      ──▶  minimum visible width, F_DEGENERATE
 *   more spans than the cap           ──▶  emitted up to it, summary.truncated
 * ```
 *
 * Dropping a row instead produces a waterfall that looks complete and is not. A hole the reader can
 * see is a finding; a hole they cannot is a lie.
 *
 * The main thread's share is zero by construction: parse, parent resolution, ordering, arithmetic
 * and interning all happen here, and a buffer of numbers crosses back (`src/shared/protocol.ts`).
 */

/** Fraction of the trace's extent given to a span with no measurable duration. */
const MIN_WIDTH = 0.002;

/** One span, after reading and before ordering. Worker-local; nothing here crosses the boundary. */
interface Span {
  id: string;
  parent: string;
  name: string;
  service: string;
  start: number;
  end: number;
  error: boolean;
  /** Insertion order, for the deterministic tie-break in {@link orderChildren}. */
  seq: number;
  depth: number;
  flags: number;
}

export interface LayoutOk {
  ok: true;
  buffer: ArrayBuffer;
  count: number;
  strings: string[];
  logs: LogRecord[];
  logsSeen: number;
  summary: LayoutSummary;
}

export interface LayoutErr {
  ok: false;
  reason: LayoutFailure;
  message: string;
}

export type LayoutResult = LayoutOk | LayoutErr;

export interface LayoutOptions {
  /** Overridden only by tests, which cannot afford to build 8192 spans to reach the cap. */
  cap?: number;
  /** Same, for {@link LOG_CAP} — 200 records is not a fixture anyone reads. */
  logCap?: number;
  /** Same, for {@link ATTR_CAP}. */
  attrCap?: number;
}

function fail(reason: LayoutFailure): LayoutErr {
  return { ok: false, reason, message: LAYOUT_FAILURE_COPY[reason] };
}

/**
 * Nanosecond timestamps arrive as strings — protojson encodes int64 as a string because JSON
 * numbers are doubles, and 2^53 ns is 1970 plus 104 days, so every real timestamp is past exact.
 *
 * Read as `Number` anyway: a considered loss with a **measured** bound. At a 2026 epoch a double's
 * spacing is 256 ns, so each endpoint rounds by up to 128 ns and a duration inherits up to 256 ns.
 * A 50 ms span in `layout.test.ts` reads back 49 999 872 ns — 128 ns short. (Subtracting nearby
 * values does *not* cancel it: the rounding happens per endpoint at parse time. An earlier comment
 * here claimed otherwise.) The test asserts the bound, not exactness.
 *
 * 256 ns is 0.00026 ms in a column rendering milliseconds, so `BigInt` per endpoint or rebasing the
 * digit string buys nothing visible for real per-span cost.
 */
function nanos(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringAttribute(attributes: unknown, key: string): string {
  if (!Array.isArray(attributes)) return "";
  for (const entry of attributes) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { key?: unknown; value?: unknown };
    if (record.key !== key) continue;
    const value = record.value as { stringValue?: unknown } | undefined;
    if (typeof value?.stringValue === "string") return value.stringValue;
  }
  return "";
}

/**
 * OTLP's status enum in both shapes protojson emits: the canonical mapping writes the enum *name*,
 * but anything round-tripping through the binary form emits the number. Both accepted; anything
 * else is not an error.
 */
function isError(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const code = (status as { code?: unknown }).code;
  return code === 2 || code === "STATUS_CODE_ERROR";
}

/**
 * Every span in an OTLP payload, with its resource's service name. `resourceSpans[].scopeSpans[]`
 * plus the older `instrumentationLibrarySpans` — renamed in OTLP 0.16, still emitted in the wild.
 */
function readSpans(payload: Record<string, unknown>, out: Span[]): void {
  const resourceSpans = payload["resourceSpans"];
  if (!Array.isArray(resourceSpans)) return;

  for (const resourceEntry of resourceSpans) {
    if (!resourceEntry || typeof resourceEntry !== "object") continue;
    const group = resourceEntry as Record<string, unknown>;
    const resource = group["resource"] as { attributes?: unknown } | undefined;
    /* An unnamed resource is normal — a span from an SDK with no `service.name` set. Named
       here rather than left blank, because a blank swatch label reads as a rendering bug. */
    const service = stringAttribute(resource?.attributes, "service.name") || "unknown service";

    const scopes = Array.isArray(group["scopeSpans"])
      ? (group["scopeSpans"] as unknown[])
      : Array.isArray(group["instrumentationLibrarySpans"])
        ? (group["instrumentationLibrarySpans"] as unknown[])
        : [];

    for (const scopeEntry of scopes) {
      if (!scopeEntry || typeof scopeEntry !== "object") continue;
      const spans = (scopeEntry as Record<string, unknown>)["spans"];
      if (!Array.isArray(spans)) continue;

      for (const spanEntry of spans) {
        if (!spanEntry || typeof spanEntry !== "object") continue;
        const span = spanEntry as Record<string, unknown>;
        const id = typeof span["spanId"] === "string" ? span["spanId"] : "";
        if (id === "") continue;
        out.push({
          id,
          parent: typeof span["parentSpanId"] === "string" ? span["parentSpanId"] : "",
          name: typeof span["name"] === "string" ? span["name"] : "(unnamed)",
          service,
          start: nanos(span["startTimeUnixNano"]),
          end: nanos(span["endTimeUnixNano"]),
          error: isError(span["status"]),
          seq: out.length,
          depth: 0,
          flags: 0,
        });
      }
    }
  }
}

/**
 * The browser web event, as the tree's root. Dash0 records the browser's view as a `webEvent`, not
 * a span, so without this the waterfall starts at the first *backend* span and silently omits the
 * half of the trace the person holding this toolbar controls. Read as a parentless span, so the
 * depth pass adopts the backend roots under it. Two accepted shapes; absent without complaint,
 * since a server-side request has no web event.
 */
function readWebEvents(payload: Record<string, unknown>, out: Span[]): void {
  const events = payload["webEvents"];
  if (!Array.isArray(events)) return;

  for (const entry of events) {
    if (!entry || typeof entry !== "object") continue;
    const event = entry as Record<string, unknown>;
    const id = typeof event["spanId"] === "string" ? event["spanId"] : "";
    if (id === "") continue;
    out.push({
      id,
      /* Deliberately rootless even if the payload names a parent. The browser is where the
         request began; hanging it under a backend span would invert the causality the panel
         exists to show. */
      parent: "",
      name: typeof event["name"] === "string" ? event["name"] : "browser",
      service: typeof event["origin"] === "string" ? event["origin"] : "browser",
      start: nanos(event["startTimeUnixNano"] ?? event["timeUnixNano"]),
      end: nanos(event["endTimeUnixNano"] ?? event["timeUnixNano"]),
      error: false,
      seq: out.length,
      depth: 0,
      flags: 0,
    });
  }
}

/**
 * One OTLP `AnyValue`, as text plus the kind it actually was.
 *
 * **One reader for bodies and attribute values both.** Two would drift, and the drift would be
 * silent — a `kvlistValue` rendering as text in one place and as its kind in the other, with
 * nothing failing. That is the same reasoning `layoutViews` exists for.
 *
 * Structured values are named, never serialised. Rejected: `JSON.stringify` in the worker — it is
 * unbounded in size, would need truncation rules of its own, and a half-printed object is worse
 * than a named kind.
 */
function anyValue(value: unknown): { text: string; kind: LogValueKind } {
  if (!value || typeof value !== "object") return { text: "", kind: "absent" };
  const v = value as Record<string, unknown>;
  if (typeof v["stringValue"] === "string") return { text: v["stringValue"], kind: "string" };
  /* protojson writes int64 as a string and the others as JSON numbers, so both are accepted per
     kind rather than by `typeof` alone. Rendered as text because a number *is* readable — only
     the container kinds are not. */
  if (v["intValue"] !== undefined) return { text: String(v["intValue"]), kind: "int" };
  if (v["doubleValue"] !== undefined) return { text: String(v["doubleValue"]), kind: "double" };
  if (v["boolValue"] !== undefined) return { text: String(v["boolValue"]), kind: "bool" };
  if (v["arrayValue"] !== undefined) return { text: "", kind: "array" };
  if (v["kvlistValue"] !== undefined) return { text: "", kind: "kvlist" };
  if (v["bytesValue"] !== undefined) return { text: "", kind: "bytes" };
  return { text: "", kind: "absent" };
}

/** A record as read, before the cap and before its row is resolved. */
interface RawLog {
  severity: number;
  level: string;
  body: string;
  bodyKind: LogValueKind;
  timeNs: number;
  spanId: string;
  attrs: LogAttr[];
  attrsSeen: number;
  /** Arrival order, so the cap's severity sort stays stable and the tie-break survives it. */
  seq: number;
}

/**
 * Every correlated log record in the payload. `scopeLogs[]` plus the pre-0.16
 * `instrumentationLibraryLogs`, matching `readSpans`.
 *
 * Reads rather than summarises. The previous version kept a count and the single most severe record
 * and dropped everything else — including every `spanId`, which is the only evidence that can
 * attach a log to a span.
 */
function readLogs(payload: Record<string, unknown>, attrCap: number): RawLog[] {
  const resourceLogs = payload["resourceLogs"];
  if (!Array.isArray(resourceLogs)) return [];

  const out: RawLog[] = [];

  for (const resourceEntry of resourceLogs) {
    if (!resourceEntry || typeof resourceEntry !== "object") continue;
    const group = resourceEntry as Record<string, unknown>;
    const scopes = Array.isArray(group["scopeLogs"])
      ? (group["scopeLogs"] as unknown[])
      : Array.isArray(group["instrumentationLibraryLogs"])
        ? (group["instrumentationLibraryLogs"] as unknown[])
        : [];

    for (const scopeEntry of scopes) {
      if (!scopeEntry || typeof scopeEntry !== "object") continue;
      const records = (scopeEntry as Record<string, unknown>)["logRecords"];
      if (!Array.isArray(records)) continue;

      for (const recordEntry of records) {
        if (!recordEntry || typeof recordEntry !== "object") continue;
        const record = recordEntry as Record<string, unknown>;
        const body = anyValue(record["body"]);

        const rawAttrs = record["attributes"];
        const attrs: LogAttr[] = [];
        let attrsSeen = 0;
        if (Array.isArray(rawAttrs)) {
          attrsSeen = rawAttrs.length;
          for (const attrEntry of rawAttrs) {
            if (attrs.length >= attrCap) break;
            if (!attrEntry || typeof attrEntry !== "object") continue;
            const attr = attrEntry as { key?: unknown; value?: unknown };
            /* A key is the whole identity of an attribute; one without it cannot be rendered as
               anything a reader could act on. A *value*-less key is kept, as `"absent"`. */
            if (typeof attr.key !== "string" || attr.key === "") continue;
            const read = anyValue(attr.value);
            attrs.push({ key: attr.key, value: read.text, kind: read.kind });
          }
        }

        out.push({
          severity: typeof record["severityNumber"] === "number" ? record["severityNumber"] : 0,
          level:
            typeof record["severityText"] === "string" && record["severityText"] !== ""
              ? record["severityText"]
              : "LOG",
          body: body.text,
          bodyKind: body.kind,
          /* `observedTimeUnixNano` is the collector's receipt time and is the documented fallback
             when the emitter set no timestamp. */
          timeNs: nanos(record["timeUnixNano"] ?? record["observedTimeUnixNano"]),
          spanId: typeof record["spanId"] === "string" ? record["spanId"] : "",
          attrs,
          attrsSeen,
          seq: out.length,
        });
      }
    }
  }

  return out;
}

/**
 * The capped records, with each one's row resolved.
 *
 * **Selected by severity, not by arrival.** The footer derives its worst-of from this list, so a
 * cap that dropped by arrival could drop the severest record and leave the footer naming a log
 * absent from the list beneath it. Arrival order is preserved within a severity, which keeps the
 * old tie-break — the earliest at the worst severity, because it explains the others.
 *
 * Attachment runs here, **after** the cap, because that is the only point where "the span is not in
 * this trace" and "the span exists and the row cap dropped it" can be told apart.
 */
function attachLogs(
  raw: RawLog[],
  options: {
    from: number;
    rowById: Map<string, number>;
    present: Map<string, Span>;
    cap: number;
  },
): LogRecord[] {
  const ordered = [...raw].sort((a, b) => b.severity - a.severity || a.seq - b.seq);
  const kept = ordered.slice(0, options.cap);
  /* Back into arrival order for display: severity decided *which* records survive, not how they
     read. A list jumping between severities is harder to scan than one that runs in time. */
  kept.sort((a, b) => a.seq - b.seq);

  return kept.map((log) => {
    const row = log.spanId === "" ? -1 : (options.rowById.get(log.spanId) ?? -1);
    let unattached: LogUnattached | 0 = 0;
    if (row < 0) {
      unattached =
        log.spanId === ""
          ? "no-span-id"
          : options.present.has(log.spanId)
            ? "span-capped"
            : "span-not-in-trace";
    }
    return {
      severity: log.severity,
      level: log.level,
      body: log.body,
      bodyKind: log.bodyKind,
      /* Clamped at 0. A log stamped before the trace's earliest emitted span is real — clocks on
         two services disagree — and is clamped rather than dropped or rendered negative. */
      offsetNs: Math.max(log.timeNs - options.from, 0),
      timeNs: log.timeNs,
      row,
      unattached,
      attrs: log.attrs,
      attrsSeen: log.attrsSeen,
    };
  });
}

/**
 * Depth resolution, cutting cycles. Iterative and memoised, not recursive: a 4000-span chain is
 * legitimately 4000 deep and would overflow the worker's stack on a payload the backend considers
 * valid. A cycle is cut at the span that closes it (root + {@link F_CYCLE}) — deterministic in
 * input order rather than dependent on where the walk entered the loop.
 */
function resolveDepths(spans: Span[], byId: Map<string, Span>): void {
  /* 0 unvisited, 1 on the current path, 2 settled. Cheaper than two sets, and the "on the
     current path" state is the whole cycle detection. */
  const state = new Uint8Array(spans.length);
  const index = new Map<string, number>();
  for (let i = 0; i < spans.length; i += 1) index.set(spans[i]!.id, i);

  const path: number[] = [];
  for (let start = 0; start < spans.length; start += 1) {
    if (state[start] === 2) continue;
    path.length = 0;

    let at = start;
    for (;;) {
      if (state[at] === 2) break;
      if (state[at] === 1) {
        /* Reached a span already on this path: the chain closed on itself. Cut it here. */
        const span = spans[at]!;
        span.parent = "";
        span.flags |= F_CYCLE;
        span.depth = 0;
        state[at] = 2;
        break;
      }
      state[at] = 1;
      path.push(at);

      const span = spans[at]!;
      if (span.parent === "") break;
      const parentIndex = index.get(span.parent);
      if (parentIndex === undefined) {
        /* The parent is not in this response. A partially ingested trace, and a real state —
           rendered at the root rather than dropped, and flagged so it is not read as one. */
        span.flags |= F_ORPHAN;
        break;
      }
      at = parentIndex;
    }

    /* Walk back down assigning depths. The end of the path is either a root, an orphan, or a
       span that was already settled — in the last case its depth is the base to build on. */
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const spanIndex = path[i]!;
      const span = spans[spanIndex]!;
      state[spanIndex] = 2;
      if (span.parent === "" || (span.flags & F_ORPHAN) !== 0) {
        span.depth = 0;
        continue;
      }
      const parent = byId.get(span.parent);
      /* Clamped: `depth` is a `u8` on the wire, and a 300-deep chain would otherwise wrap to a
         small number and render as a plausible-looking tree that is not the one in the data. */
      span.depth = parent === undefined ? 0 : Math.min(parent.depth + 1, 255);
    }
  }
}

/**
 * Render order: depth-first pre-order, roots in input order, children in start order. The main
 * thread renders straight out of the array and never sorts or traverses, so the traversal happens
 * here and is baked into the row indices.
 */
function orderChildren(spans: Span[]): Span[] {
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];

  for (const span of spans) {
    const parent = (span.flags & F_ORPHAN) !== 0 ? "" : span.parent;
    if (parent === "") {
      roots.push(span);
      continue;
    }
    const bucket = children.get(parent);
    if (bucket) bucket.push(span);
    else children.set(parent, [span]);
  }

  /* Earliest first, and by input order where two spans share a start — so the same payload
     always produces the same waterfall, which is what makes the palette stable too. */
  const byStart = (a: Span, b: Span): number => a.start - b.start || a.seq - b.seq;
  roots.sort(byStart);
  for (const bucket of children.values()) bucket.sort(byStart);

  const ordered: Span[] = [];
  /* Explicit stack, for the same reason `resolveDepths` is iterative: a legitimately deep
     trace must not take the worker's stack with it. Pushed reversed so siblings pop in order. */
  const stack: Span[] = roots.slice().reverse();
  while (stack.length > 0) {
    const span = stack.pop()!;
    ordered.push(span);
    const kids = children.get(span.id);
    if (!kids) continue;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  }

  /* A span reachable from no root at all — every ancestor cut, or a component the walk never
     entered. Appended rather than lost: the cap is the only thing allowed to drop a row. */
  if (ordered.length < spans.length) {
    const emitted = new Set(ordered);
    for (const span of spans) if (!emitted.has(span)) ordered.push(span);
  }

  return ordered;
}

/**
 * Flattens one OTLP payload into positioned rows.
 *
 * Pure, and the whole of the layout: `layout.worker.ts` adds nothing but the message plumbing.
 */
export function layout(request: LayoutRequest, options: LayoutOptions = {}): LayoutResult {
  if (request.version !== LAYOUT_PROTOCOL_VERSION) return fail("version-mismatch");

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return fail("malformed-json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("not-otlp");

  const payload = parsed as Record<string, unknown>;
  if (!Array.isArray(payload["resourceSpans"]) && !Array.isArray(payload["webEvents"])) {
    return fail("not-otlp");
  }

  const spans: Span[] = [];
  readWebEvents(payload, spans);
  readSpans(payload, spans);
  if (spans.length === 0) return fail("empty");

  /* First writer wins, so a duplicated span id resolves to the earliest copy for every child
     rather than to whichever happened to be read last. */
  const byId = new Map<string, Span>();
  for (const span of spans) if (!byId.has(span.id)) byId.set(span.id, span);

  resolveDepths(spans, byId);
  const ordered = orderChildren(spans);

  const cap = options.cap ?? SPAN_CAP;
  const count = Math.min(ordered.length, cap);
  const truncated = ordered.length > count;

  /* The denominator. Taken from the emitted rows, not from all of them: a row past the cap
     cannot widen a bar the reader can see, and including it would shrink every visible span to
     make room for one that is not there. */
  let from = Infinity;
  let to = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const span = ordered[i]!;
    if (span.start > 0 && span.start < from) from = span.start;
    if (span.end > to) to = span.end;
    if (span.start > to) to = span.start;
  }
  /* No usable extent — one instantaneous span, or a payload whose timestamps are all zero.
     Falls back to the query window, which is the only other real scale available. See the note
     on `LayoutRequest.from`. */
  if (!Number.isFinite(from) || to <= from) {
    from = request.from * 1e6;
    to = request.to * 1e6;
  }
  const total = to > from ? to - from : 1;

  /* Emitted rows only, and first-writer-wins for a duplicated span id — matching `byId`, so a log
     naming a duplicated id attaches to the same copy every child resolved to. `byId` holds every
     span *read*, which is what separates `span-capped` from `span-not-in-trace` below. */
  const rowById = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    const id = ordered[i]!.id;
    if (!rowById.has(id)) rowById.set(id, i);
  }

  const rawLogs = readLogs(payload, options.attrCap ?? ATTR_CAP);
  const logs = attachLogs(rawLogs, {
    from,
    rowById,
    present: byId,
    cap: options.logCap ?? LOG_CAP,
  });
  /* Which rows to mark, resolved before the row loop because `flags` is written once per row. */
  const rowsWithLog = new Set<number>();
  for (const log of logs) if (log.row >= 0) rowsWithLog.add(log.row);

  const buffer = layoutBuffer(count);
  const views = layoutViews(buffer, count);
  const strings: string[] = [];
  const interned = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = interned.get(value);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(value);
    interned.set(value, id);
    return id;
  };

  /* Palette per service, assigned on first appearance in render order — so a service keeps one
     colour down the whole tree, and the same payload always assigns the same colours. */
  const palette = new Map<string, number>();

  for (let i = 0; i < count; i += 1) {
    const span = ordered[i]!;
    const duration = span.end - span.start;
    const degenerate = !(duration > 0);

    let colour = palette.get(span.service);
    if (colour === undefined) {
      colour = palette.size;
      palette.set(span.service, colour);
    }

    const left = (span.start - from) / total;
    const width = degenerate ? MIN_WIDTH : duration / total;

    views.durationNs[i] = degenerate ? 0 : duration;
    views.nameId[i] = intern(span.name);
    views.serviceId[i] = intern(span.service);
    /* Clamped into the track. A span that started before the earliest emitted row — possible
       once the cap has removed that row — would otherwise be positioned off the left edge and
       simply not be seen. */
    views.left[i] = Math.min(Math.max(left, 0), 1);
    views.width[i] = Math.min(Math.max(width, MIN_WIDTH), 1 - views.left[i]!);
    views.depth[i] = span.depth;
    /* Wrapped rather than trusted: the palette is nine slots wide and a fortieth service must
       reuse a colour, not write an index that resolves to no custom property and paints
       nothing. */
    views.paletteIndex[i] = colour % 9;
    views.flags[i] =
      span.flags |
      (span.error ? F_ERROR : 0) |
      (degenerate ? F_DEGENERATE : 0) |
      (rowsWithLog.has(i) ? F_HAS_LOG : 0) |
      (span.depth === 0 && (span.flags & (F_ORPHAN | F_CYCLE)) === 0 ? F_ROOT : 0);
  }

  const summary: LayoutSummary = {
    spanCount: count,
    spansSeen: ordered.length,
    serviceCount: palette.size,
    logCount: rawLogs.length,
    truncated,
    totalDurationNs: total,
  };

  return { ok: true, buffer, count, strings, logs, logsSeen: rawLogs.length, summary };
}

/**
 * A {@link LayoutResult} as the message to post plus its transfer list. Here rather than in the
 * entry so the *transfer* is covered by a node test rather than by whatever a browser happens to
 * do; returning the list alongside makes forgetting it a type error, not a silent clone.
 */
export function toResponse(
  id: number,
  result: LayoutResult,
  workerMs: number,
): { message: LayoutResponse; transfer: Transferable[] } {
  if (!result.ok) {
    return {
      message: {
        kind: "layout-error",
        version: LAYOUT_PROTOCOL_VERSION,
        id,
        reason: result.reason,
        message: result.message,
      },
      transfer: [],
    };
  }
  return {
    message: {
      kind: "layout-ok",
      version: LAYOUT_PROTOCOL_VERSION,
      id,
      buffer: result.buffer,
      count: result.count,
      strings: result.strings,
      logs: result.logs,
      logsSeen: result.logsSeen,
      summary: result.summary,
      workerMs,
    },
    transfer: [result.buffer],
  };
}
