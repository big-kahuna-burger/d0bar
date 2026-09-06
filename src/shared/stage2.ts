import { background } from "./schedule";
import type { RequestRecord } from "./record";
import type { SpanEntry } from "../collector/join";

/**
 * The stage-2 boundary.
 *
 * Stage 1 is the only thing on the host's critical path; the panel is a separate bundle fetched
 * on first open (or a post-settle prefetch). Free rather than a trade-off because `buffered:
 * true` re-delivers every entry from page start.
 *
 * Loaded by runtime URL, not `import("../panel")`: a static specifier makes Rollup emit a chunk,
 * and IIFE output cannot code-split, so Rollup inlines it back and stage 2 silently lands on the
 * critical path. The URL is a sibling of stage 1's own location, so CDN and hashed layouts work.
 *
 * **THE DUPLICATION RULE.** Both stages bundle their own copy of every module, each with its own
 * module-level state. Anything stage 1 resolves or accumulates must cross this interface; stage 2
 * importing the module gets a second, empty one. Observed four times, silently: `sw.ts` reported
 * `off` for an active worker, `otel.ts` reported `no-sdk` on an instrumented page, `ring.ts` gave
 * an empty ring (a badge reading 307 untraced on a page where almost everything was traced), and
 * `vitals.ts` reported `LCP unavailable` where the browser had reported one.
 */

/** Filename of the stage-2 bundle, a sibling of stage 1. */
const STAGE_2 = "d0bar.panel.js";

/**
 * Stage 1's own URL, captured at module evaluation because both sources expire.
 * `document.currentScript` is live only during classic-script execution (the IIFE case) and null
 * in an ES module, where `import.meta.url` answers instead.
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

/** In-flight or settled load: a click during a prefetch joins it. Cleared on failure to retry. */
let cached: Promise<PanelModule> | undefined;

/** What stage 2 must export. Structural, so stage 1 never imports stage 2's types. */
export interface PanelModule {
  openPanel(options: PanelOptions): PanelHandle;
}

export interface PanelOptions {
  /** The closed shadow root the pill already owns. The panel mounts inside it. */
  root: ShadowRoot;
  /** Returns focus to the pill on close. */
  onClose(): void;
  /** Tier 2's resolved state. Crosses the boundary per the duplication rule. */
  tier2: Tier2State;
  /** Tier 4's resolved state. Crosses the boundary per the duplication rule. */
  otel: OtelState;
  /** The request ring, which stage 1 owns. Projected, not copied — see `Tier1Access`. */
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
  /** Tier 4's adopted spans. Empty is the ordinary case — most pages have no OTel SDK. */
  spans(): SpanEntry[];
  /**
   * Writes tier 4's identity onto a record tier 2 never matched. Identity only, enforced by the
   * type: no field for a timing, status or size, so tier 4 cannot overwrite a tier 1 measurement.
   * A record tier 2 already keyed keeps tier 2's — the header is what the backend received.
   */
  adoptSpan(index: number, contextId: number): void;
  /**
   * Sets `F_TRACE_CONFLICT` where tier 2 and tier 4 disagree on the trace id, and nothing else.
   * Not resolved anywhere: one join matched the wrong pair, and picking a winner would print a
   * wrong trace id with full confidence.
   */
  flagConflict(index: number): void;
  /**
   * `written` is the absolute count ever recorded, which is how the list detects that the ring's
   * base moved: on overflow every retained index shifts down by one, and a scroll offset and a
   * selected index not adjusted together silently come to mean different rows.
   */
  stats(): { written: number; dropped: number; capacity: number };
  /**
   * Fills `out` with the record at `index` from the oldest retained; false when out of range.
   * Fill-a-scratch, not return-a-record: the list re-reads its whole window every repaint, and a
   * per-row object would be an allocation per row per frame on the page being measured.
   */
  read(index: number, out: RequestRecord): boolean;
  /**
   * Notified once per post-settle resource batch; returns a teardown. Push, not poll — polling the
   * ring each frame burns a frame's work on every frame where nothing happened.
   */
  onBatch(fn: () => void): () => void;
  /**
   * Visibility, from the `visibility-state` entry type rather than a `visibilitychange` listener.
   * Crosses the boundary so stage 2 registers none either — `non-perturbation.spec.ts` asserts
   * zero host listeners against the browser's real registry.
   */
  onVisibility(fn: (visible: boolean) => void): () => void;
  visible(): boolean;
  /** The vitals accumulator's reading. Crosses the boundary per the duplication rule. */
  vitals(): VitalsReading;
  /**
   * Notified once per vitals batch; returns a teardown. Its own signal, not the resource batch: a
   * layout shift is not a request, and sharing one would repaint the list once per shift.
   */
  onVitals(fn: () => void): () => void;
}

/**
 * What the vitals surface may know: numbers and strings, never an entry, never a DOM node.
 *
 * The absence conventions are load-bearing, which is why the shape is declared here:
 *
 *   lcp / inp / ttfb        `-1` when none was reported. Not 0 — 0 renders as a very good score.
 *   cls / loafCount         0 legitimately: a `buffered` observer with no shift means no shift.
 *                           Whether the observer exists at all is `entryTypes`, not the value.
 *   attribution strings     empty when the entry carried none. The card says unavailable rather
 *                           than naming a likely element.
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

/** Mirrors `collector/otel.ts`. Duplicated per the duplication rule. */
export type OtelState =
  | { kind: "live"; owner: "d0bar" | "host" }
  | {
      kind: "off";
      reason: "no-sdk" | "no-provider" | "provider-sealed" | "attach-failed";
    };

/** Mirrors `collector/sw.ts`. Duplicated per the duplication rule. */
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

/** Loads stage 2, reusing an in-flight load. Rejects if it cannot be fetched. */
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
 * Warms stage 2 at background priority, post-settle only, so the fetch cannot compete with the
 * host's critical requests. Failure is silent: a prefetch is an optimisation, and an error for one
 * reports a problem the user does not have. The click path surfaces a real failure.
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
