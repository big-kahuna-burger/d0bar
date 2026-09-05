import { ABSENT, OVERFLOW, intern, str } from "../shared/intern";

/**
 * Tier 4's span sink.
 *
 * A `SpanProcessor` that reads and never exports. The host's SDK already ends every span it
 * creates; this observes that moment, copies five primitives out and lets the span go. It is
 * the same posture as the service worker in tier 2 — observe what the host is already doing,
 * add nothing to it.
 *
 * **What must not happen here.** `onEnd` runs synchronously inside the host's own span
 * lifecycle, on the main thread, on a page whose INP d0bar is claiming not to move. So:
 *
 *   - no exporter, no network, no serialisation — `forceFlush` and `shutdown` resolve
 *     immediately because there is genuinely nothing to flush;
 *   - `onStart` is empty. A span that is started and never ended is not evidence of anything
 *     the panel can show, and doing work at start doubles the per-span cost;
 *   - the `ReadableSpan` is not retained. It holds its attributes, links, events and the
 *     whole `Resource` — keeping one to read later keeps all of it, on memory that belongs
 *     to the customer's page. Every field is copied out before the callback returns. This
 *     module's entire state is five `TypedArray`s and three counters, which cannot hold an
 *     object reference at all; `tests/unit/otel-sink.test.ts` asserts the copy by mutating a
 *     span after the callback and watching the row not move. A `WeakRef` assertion was tried
 *     first and abandoned — collection is not observable in that harness even for a plain
 *     unreferenced object, so it would have measured vitest rather than this file.
 *
 * **Why a URL is required.** A span with no URL attribute cannot be joined to a resource
 * entry, and the only alternative — matching on the span's name — is exactly the kind of
 * plausible inference this project refuses: a host is free to name a span `GET /api/quote`
 * for a request to a different origin, or to name three spans the same. Those spans are
 * counted and dropped, and the count is reported rather than the loss being silent.
 */

/** Fixed, and small. Tier 4 spans are the host's own, and a page that makes thousands has
    already told us more than the panel can show. Power of two so the mask is a mask. */
export const SPAN_CAPACITY = 256;
const MASK = SPAN_CAPACITY - 1;

/* Two f64 (start, end), three u32 (trace id, span id, url — all interned). Span and trace
   ids are interned rather than stored as strings for the same reason URLs are: the join
   keys on them, and an integer compare is not a string compare. They repeat, too — every
   span of one trace carries the same trace id. */
const startTimes = new Float64Array(SPAN_CAPACITY);
const endTimes = new Float64Array(SPAN_CAPACITY);
const traceIds = new Uint32Array(SPAN_CAPACITY);
const spanIds = new Uint32Array(SPAN_CAPACITY);
const urlIds = new Uint32Array(SPAN_CAPACITY);

let written = 0;
let dropped = 0;
/** Spans that ended carrying no usable URL attribute. Reported, never guessed at. */
let urlless = 0;

/**
 * One adopted span, as the panel sees it.
 *
 * Filled into a caller-owned object, like `ring.read`, so reading the whole sink for a join
 * does not allocate one object per span.
 */
export interface SpanRow {
  traceId: string;
  spanId: string;
  url: string;
  startTime: number;
  endTime: number;
}

export function spanScratch(): SpanRow {
  return { traceId: "", spanId: "", url: "", startTime: 0, endTime: 0 };
}

/**
 * The subset of `ReadableSpan` this file touches.
 *
 * Structural and minimal, and declared here rather than imported: `@opentelemetry/*` is
 * banned from `src/**` by an ESLint rule, because importing the API to get a type is one
 * refactor away from importing it to get a value, and tier 4's entire claim is that d0bar
 * ships no OpenTelemetry code. Every member is optional — this object comes from the host's
 * SDK, whose version d0bar does not control and must not assume.
 */
export interface EndedSpan {
  name?: unknown;
  spanContext?: () => { traceId?: unknown; spanId?: unknown } | undefined;
  startTime?: unknown;
  endTime?: unknown;
  attributes?: Record<string, unknown> | undefined;
}

/**
 * The span-processor surface, as the SDK calls it.
 *
 * Declared structurally for the same reason as {@link EndedSpan}. A host installing
 * `otelSpanProcessor()` into their own provider is type-checked by *their* SDK against this
 * object, which is the only place the two shapes have to agree.
 */
export interface ReadOnlySpanProcessor {
  onStart(): void;
  onEnd(span: EndedSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Where a URL lives on an HTTP client span.
 *
 * `url.full` is the current semantic convention; `http.url` is what every SDK older than the
 * stabilisation still emits, and both are in the field today. Read in that order and no
 * further — a third fallback would be a guess about a convention that does not exist.
 */
const URL_KEYS = ["url.full", "http.url"] as const;

/**
 * Converts the SDK's `HrTime` to milliseconds on the performance timeline.
 *
 * `HrTime` is `[epochSeconds, nanoseconds]` — wall clock, not `performance.now()`. The ring's
 * timings are relative to `timeOrigin`, so the two are only comparable once one is moved onto
 * the other's axis, and getting this wrong would produce a join that is off by the age of the
 * page rather than one that is visibly broken.
 */
function hrToRelative(value: unknown, timeOrigin: number): number {
  if (!Array.isArray(value) || value.length < 2) return -1;
  const seconds = value[0];
  const nanos = value[1];
  if (typeof seconds !== "number" || typeof nanos !== "number") return -1;
  return seconds * 1000 + nanos / 1e6 - timeOrigin;
}

/**
 * Reads the span's URL and resolves it against the document.
 *
 * The convention says `url.full` is absolute, and every auto-instrumentation writes it that
 * way — but the join keys on an exact string match against the resource entry's `name`,
 * which is always absolute, so a hand-instrumented span carrying `/api/quote` matches
 * nothing and does so **silently**. That is the failure this project cannot have: the panel
 * would show the request untraced on a page where the SDK traced it, with no error anywhere.
 * Observed against a real `WebTracerProvider` in `tests/perf/otel.spec.ts` — every span was
 * recorded and none of them joined.
 *
 * Resolution is not inference. `new URL(value, base)` is what the browser itself does with
 * the same string, so this reads the URL the request actually went to rather than guessing
 * at one.
 */
function urlOf(attributes: Record<string, unknown> | undefined, base: string): string {
  if (!attributes) return "";
  for (const key of URL_KEYS) {
    const value = attributes[key];
    if (typeof value !== "string" || value === "") continue;
    try {
      return new URL(value, base).href;
    } catch {
      /* Not a URL at all. Reported as absent, which routes it to the urlless count rather
         than into the ring as a key that can never match. */
      return "";
    }
  }
  return "";
}

/**
 * Builds the processor.
 *
 * `timeOrigin` is injected rather than read from `performance` so a test can drive the
 * conversion above with a fixed origin, and so the module has no import-time dependency on a
 * browser global.
 */
export function createSpanSink(
  timeOrigin: number = performance.timeOrigin,
  base: string = typeof location !== "undefined" ? location.href : "http://localhost/",
): ReadOnlySpanProcessor {
  return {
    /* Empty by design — see the module note. Present because the interface requires it. */
    onStart() {},

    onEnd(span: EndedSpan) {
      const url = urlOf(span.attributes, base);
      if (url === "") {
        /* Counted, not matched by name. A span with no URL is a span this tier cannot join,
           and saying so is the only honest thing available. */
        urlless += 1;
        return;
      }

      const context = typeof span.spanContext === "function" ? span.spanContext() : undefined;
      const traceId = context?.traceId;
      const spanId = context?.spanId;
      if (typeof traceId !== "string" || typeof spanId !== "string") {
        urlless += 1;
        return;
      }

      const urlId = intern(url);
      /* An overflowing URL collapses onto the same id as every other overflowing URL, so
         retaining it would let the join attach one request's trace to another's timings.
         Dropped, and counted as dropped. */
      if (urlId === ABSENT || urlId === OVERFLOW) {
        dropped += 1;
        return;
      }

      const slot = written & MASK;
      if (written >= SPAN_CAPACITY) dropped += 1;
      startTimes[slot] = hrToRelative(span.startTime, timeOrigin);
      endTimes[slot] = hrToRelative(span.endTime, timeOrigin);
      traceIds[slot] = intern(traceId);
      spanIds[slot] = intern(spanId);
      urlIds[slot] = urlId;
      written += 1;
    },

    /* Nothing is buffered for export, so both resolve immediately rather than pretending to
       do work. A processor that stalled the SDK's shutdown would delay the host's own
       exporter on unload — the one moment a page cannot afford it. */
    forceFlush() {
      return Promise.resolve();
    },
    shutdown() {
      return Promise.resolve();
    },
  };
}

/** Retained spans, and what was lost. Mirrors `ring.stats()`. */
export function spanStats(): {
  written: number;
  dropped: number;
  urlless: number;
  capacity: number;
} {
  return { written, dropped, urlless, capacity: SPAN_CAPACITY };
}

/** Spans currently retained, oldest first. */
export function spanCount(): number {
  return Math.min(written, SPAN_CAPACITY);
}

/**
 * Fills `out` with the span at `index`, counting from the oldest retained span. Returns false
 * when the index is out of range.
 */
export function readSpan(index: number, out: SpanRow): boolean {
  const retained = spanCount();
  if (index < 0 || index >= retained) return false;
  const base = written > SPAN_CAPACITY ? written - SPAN_CAPACITY : 0;
  const slot = (base + index) & MASK;
  out.traceId = str(traceIds[slot]!);
  out.spanId = str(spanIds[slot]!);
  out.url = str(urlIds[slot]!);
  out.startTime = startTimes[slot]!;
  out.endTime = endTimes[slot]!;
  return true;
}

/** Test seam. Not reachable from the public entry point. */
export function resetSpanSink(): void {
  written = 0;
  dropped = 0;
  urlless = 0;
  startTimes.fill(0);
  endTimes.fill(0);
  traceIds.fill(0);
  spanIds.fill(0);
  urlIds.fill(0);
}
