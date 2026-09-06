import { background } from "./schedule";
import type { RequestRecord } from "./record";
import type { SpanEntry } from "../collector/join";

/**
 * The stage-2 boundary.
 *
 * Stage 1 is the only thing on a host page's critical path, so the panel is a separate file
 * that is not fetched until someone opens it — or until a background prefetch after settle
 * decides to warm it. `buffered: true` is what makes this free rather than a trade-off: a
 * panel that loads late still receives every entry from page start, so nothing is lost by
 * not being there.
 *
 * **Why a runtime URL rather than `import("../panel")`.** A static dynamic-import specifier
 * makes Rollup emit a chunk, which works for the ES build and silently defeats the IIFE one:
 * IIFE output cannot code-split, so Rollup inlines the chunk back into the single bundle and
 * stage 2 lands on the critical path with no error to notice. Stage 2 is therefore built as
 * its own ES module and loaded by URL, which behaves identically from either build — dynamic
 * `import()` is available in classic scripts, not just modules.
 *
 * The URL is derived from stage 1's own location, so a host serving the bundle from a CDN or
 * a hashed path gets a sibling lookup rather than a guess about their layout.
 */

/** Filename of the stage-2 bundle, a sibling of stage 1. */
const STAGE_2 = "d0bar.panel.js";

/**
 * Stage 1's own URL, captured at module evaluation.
 *
 * `document.currentScript` is a live element only while a classic script is executing, which
 * is exactly the IIFE case; it is `null` during ES module evaluation, where `import.meta.url`
 * is the answer instead. Captured now because both become unavailable later.
 */
const selfUrl = (() => {
  const tag = typeof document !== "undefined" ? document.currentScript : null;
  if (tag instanceof HTMLScriptElement && tag.src) return tag.src;
  try {
    return import.meta.url;
  } catch {
    return undefined;
  }
})();

let override: string | undefined;

/** Test seam, and an escape hatch for a host with an unusual asset layout. */
export function setStage2Url(url: string | undefined): void {
  override = url;
  cached = undefined;
}

function stage2Url(): string | undefined {
  if (override) return override;
  if (!selfUrl) return undefined;
  try {
    return new URL(STAGE_2, selfUrl).href;
  } catch {
    return undefined;
  }
}

/**
 * The in-flight or settled load. Cached so a click during a prefetch joins that fetch rather
 * than starting a second one, and cleared on failure so a retry is possible.
 */
let cached: Promise<PanelModule> | undefined;

/** What stage 2 must export. Kept structural so stage 1 never imports stage 2's types. */
export interface PanelModule {
  openPanel(options: PanelOptions): PanelHandle;
}

export interface PanelOptions {
  /** The closed shadow root the pill already owns. The panel mounts inside it. */
  root: ShadowRoot;
  /** Returns focus to the pill on close. */
  onClose(): void;
  /**
   * Tier 2's state, resolved by stage 1 and handed over at open time.
   *
   * The two stages are separate bundles, so every module exists twice with its own
   * module-level state. `sw.ts` records the registration outcome in a variable that stage 2's
   * copy never sees — the panel read `off` for a worker that was registered, active and
   * controlling the page. Anything stage 1 resolves and stage 2 needs has to cross here.
   *
   * Structural, like the rest of this interface, so stage 1 still imports none of stage 2's
   * types: this is the shape both sides agree on, declared once, on the boundary.
   */
  tier2: Tier2State;
  /**
   * Tier 4's state, resolved by stage 1 and handed over at open time.
   *
   * Crosses the boundary for exactly the reason `tier2` does, and the failure would be the
   * same shape: `otel.ts` records the detection outcome in a module-level variable, so
   * stage 2's copy of that module is a second one that has never run detection and reports
   * `no-sdk` on a page whose provider d0bar is attached to.
   */
  otel: OtelState;
  /**
   * Access to the request ring, which stage 1 owns.
   *
   * Handed over rather than imported, for the same reason as `tier2` and with a sharper
   * failure: `ring.ts` holds its records in a module-level typed array, so stage 2's copy of
   * that module is a *second, empty ring*. Importing it from the panel produced a join with
   * nothing on the tier 1 side, which reported every one of the worker's records as an
   * untraced request — a badge reading 307 on a page where almost everything was traced.
   *
   * Not a data copy: `entries()` projects the three fields the join needs, and `correlate()`
   * writes results back into the real ring in stage 1.
   */
  tier1: Tier1Access;
}

export interface Tier1Access {
  /** The current ring contents, projected to what the join keys on. */
  entries(): Array<{ index: number; url: string; startTime: number }>;
  /** Writes tier 2's fields back. Timings and status are not passed and cannot be touched. */
  correlate(
    index: number,
    fields: { method: string; contextId: number; hasSpan: boolean },
  ): void;
  /**
   * The spans tier 4 has adopted, projected to what the join keys on.
   *
   * Handed across for the same reason as the ring: `otel-sink.ts` holds its spans in
   * module-level typed arrays, so stage 2's copy of that module is a second, empty sink. An
   * empty array here is the ordinary case — most pages have no OpenTelemetry SDK.
   */
  spans(): SpanEntry[];
  /**
   * Writes tier 4's identity onto a record tier 2 never matched.
   *
   * Identity only, and the type is what enforces it: there is no field here for a timing, a
   * status or a size, so tier 4 cannot overwrite a number tier 1 measured. A record tier 2
   * already gave a trace id keeps tier 2's — the header is what the backend received.
   */
  adoptSpan(index: number, contextId: number): void;
  /**
   * Marks a record where tier 2 and tier 4 disagree about the trace id.
   *
   * Sets `F_TRACE_CONFLICT` and nothing else. The disagreement is not resolved here or
   * anywhere: one of the two joins matched the wrong pair, and picking a winner would print
   * a wrong trace id with full confidence.
   */
  flagConflict(index: number): void;
  /**
   * Records currently retained, and how many were lost to overflow.
   *
   * `written` is the absolute count of everything ever recorded, which is what tells the
   * list that the ring's base moved: on overflow every retained record's index shifts down
   * by one, so a scroll offset and a selected index that are not adjusted by the same amount
   * silently come to mean different rows.
   */
  stats(): { written: number; dropped: number; capacity: number };
  /**
   * Fills `out` with the record at `index`, counting from the oldest retained record.
   * Returns false when the index is out of range.
   *
   * Fill-a-scratch rather than return-a-record, across the boundary as well as inside it:
   * the list re-reads its whole window on every repaint, and a per-row object would put an
   * allocation per row per frame on the main thread of the page being measured.
   */
  read(index: number, out: RequestRecord): boolean;
  /**
   * Notified once after each post-settle batch of resource entries. Returns a teardown.
   *
   * Push, not poll. The alternative — the panel checking the ring's length every frame while
   * open — burns a frame's worth of work on every frame in which nothing happened.
   */
  onBatch(fn: () => void): () => void;
  /**
   * Document visibility, read from the `visibility-state` entry type rather than from a
   * `visibilitychange` listener, and handed across the boundary for that reason: stage 2
   * registering its own listener would break the zero-host-listeners property that
   * `non-perturbation.spec.ts` asserts against the browser's real listener registry.
   */
  onVisibility(fn: (visible: boolean) => void): () => void;
  visible(): boolean;
  /**
   * The vitals accumulator's current reading, plus the entry types this browser accepted.
   *
   * Handed across for the same reason as the ring, and it is not a hypothetical: the
   * accumulator in `collector/vitals.ts` keeps its totals in module-level variables, so
   * importing that module from the panel yields a second, empty copy that would report
   * `LCP unavailable` on a page where the browser had reported one. This is the only way
   * stage 2 sees stage 1's numbers.
   */
  vitals(): VitalsReading;
  /**
   * Notified once after each batch of vitals entries. Returns a teardown.
   *
   * Its own signal, not the resource batch: a layout shift is not a request, and firing the
   * two together would repaint the requests list once per shift on the page being measured.
   */
  onVitals(fn: () => void): () => void;
}

/**
 * What the vitals surface is allowed to know.
 *
 * Every field is a number or a string — never a browser entry and never a DOM node. The
 * absence conventions are load-bearing and are the whole reason this shape is declared on the
 * boundary rather than inferred:
 *
 *   - `lcp`, `inp`, `ttfb` are `-1` when the browser has reported none. Not zero: a zero here
 *     would render as a very good score for a measurement that never happened.
 *   - `cls` and `loafCount` start at zero legitimately — an observer registered with
 *     `buffered: true` that has delivered no shift is reporting that the page did not shift.
 *     Whether the observer exists at all is `entryTypes`, not the value.
 *   - the attribution strings are empty when the entry carried no attribution. The card then
 *     states that attribution is unavailable rather than naming a likely element.
 */
export interface VitalsReading {
  lcp: number;
  cls: number;
  inp: number;
  ttfb: number;
  loafCount: number;
  loafLongest: number;
  lcpElement: string;
  clsSource: string;
  inpTarget: string;
  inpTargetIsScored: boolean;
  loafScript: string;
  /** Entry types this browser accepted. An absent type is a state to report, not an error. */
  entryTypes: readonly string[];
}

/** Mirrors `collector/otel.ts`. Duplicated deliberately — see the note on `PanelModule`. */
export type OtelState =
  | { kind: "live"; owner: "d0bar" | "host" }
  | {
      kind: "off";
      reason: "no-sdk" | "no-provider" | "provider-sealed" | "attach-failed";
    };

/** Mirrors `collector/sw.ts`. Duplicated deliberately — see the note on `PanelModule`. */
export type Tier2State =
  | { kind: "live"; owner: "d0bar" | "host" }
  | {
      kind: "off";
      reason:
        | "unsupported"
        | "insecure-context"
        | "scope-owned"
        | "registration-failed"
        | "not-registered";
    };

export interface PanelHandle {
  show(): void;
  close(): void;
  destroy(): void;
}

/**
 * Loads stage 2, reusing an in-flight load. Rejects if the module cannot be fetched; the
 * caller decides whether that is worth showing.
 */
export function loadStage2(): Promise<PanelModule> {
  if (cached) return cached;

  const url = stage2Url();
  if (!url) {
    return Promise.reject(
      new Error("d0bar: could not resolve the panel bundle's URL from stage 1's own location."),
    );
  }

  cached = (import(/* @vite-ignore */ url) as Promise<PanelModule>).catch((error: unknown) => {
    /* Cleared so a later click retries rather than replaying a stale rejection forever. */
    cached = undefined;
    throw error;
  });

  return cached;
}

/**
 * Warms stage 2 at background priority.
 *
 * Called only after the load phase has settled, so the fetch cannot compete with the host's
 * own critical requests. Failure is silent by design — a prefetch is an optimisation, and a
 * console error for one would report a problem the user does not have. The click path
 * surfaces a real failure.
 */
export function prefetchStage2(): () => void {
  return background(() => {
    loadStage2().catch(() => {});
  });
}

/** Test seam. */
export function resetStage2(): void {
  cached = undefined;
  override = undefined;
}
