import {
  F_CYCLE,
  F_DEGENERATE,
  F_ERROR,
  F_ORPHAN,
  F_ROOT,
  LAYOUT_FAILURE_COPY,
  LAYOUT_PROTOCOL_VERSION,
  SPAN_CAP,
  layoutBuffer,
  layoutViews,
  type LayoutFailure,
  type LayoutRequest,
  type LayoutResponse,
  type LayoutSummary,
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

/** The correlated logs, and the most severe one for the footer. */
function readLogs(payload: Record<string, unknown>): { count: number; worst?: LogLine } {
  const resourceLogs = payload["resourceLogs"];
  if (!Array.isArray(resourceLogs)) return { count: 0 };

  let count = 0;
  let worst: LogLine | undefined;

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
        count += 1;
        const level =
          typeof record["severityText"] === "string" && record["severityText"] !== ""
            ? record["severityText"]
            : "LOG";
        const number =
          typeof record["severityNumber"] === "number" ? record["severityNumber"] : 0;
        const body = record["body"] as { stringValue?: unknown } | undefined;
        const message = typeof body?.stringValue === "string" ? body.stringValue : "";
        /* Strictly greater, so the *first* log at the worst severity wins a tie. The footer
           shows one line, and the earliest one at that severity is the one that explains the
           others. */
        if (worst === undefined || number > worst.severity) {
          worst = { severity: number, level, message };
        }
      }
    }
  }

  return worst === undefined ? { count } : { count, worst };
}

interface LogLine {
  severity: number;
  level: string;
  message: string;
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
      (span.depth === 0 && (span.flags & (F_ORPHAN | F_CYCLE)) === 0 ? F_ROOT : 0);
  }

  const logs = readLogs(payload);
  const summary: LayoutSummary = {
    spanCount: count,
    spansSeen: ordered.length,
    serviceCount: palette.size,
    logCount: logs.count,
    truncated,
    totalDurationNs: total,
    ...(logs.worst ? { log: { level: logs.worst.level, message: logs.worst.message } } : {}),
  };

  return { ok: true, buffer, count, strings, summary };
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
      summary: result.summary,
      workerMs,
    },
    transfer: [result.buffer],
  };
}
