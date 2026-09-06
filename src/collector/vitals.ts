/**
 * Browser-recorded vitals.
 *
 * Every number here is read from a browser performance entry. The toolbar computes no
 * timing of its own — that is the whole claim of the vitals surface, and it constrains the
 * implementation: where the browser does not report something, the value stays unset and
 * the UI says so.
 *
 * Stage 1 needs only enough to colour the pill's worst-offender dot. The cards and their
 * attribution lines are a later change; the accumulation here is already the standard
 * definition so those cards do not have to restate it.
 */

import { lcpSealTime } from "./phase";
import type { VitalsReading } from "../shared/stage2";

export const HEALTHY = 0;
export const WARNING = 1;
export const POOR = 2;
export type Bucket = typeof HEALTHY | typeof WARNING | typeof POOR;

/** Standard Core Web Vitals thresholds: at or below good, at or below needs-improvement. */
const THRESHOLDS = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
} as const;

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources?: ArrayLike<{ node?: unknown }>;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
  target?: unknown;
}

interface LcpEntry extends PerformanceEntry {
  element?: unknown;
}

interface LoafEntry extends PerformanceEntry {
  scripts?: ArrayLike<{ duration?: number; sourceFunctionName?: string }>;
}

/**
 * A bounded, node-free description of an element.
 *
 * Two properties matter more than prettiness. It never walks the tree — one element, no
 * ancestors, no `nth-child` search — because this runs from a `PerformanceObserver` callback
 * on the page being measured. And it returns a *string*: the entry's `element`, a shift's
 * `sources[i].node` and an event's `target` are live DOM nodes, and a module-level variable
 * holding one keeps a detached subtree alive for the life of the page. A performance tool
 * that leaks the DOM it observed is the failure it exists to prevent.
 *
 * Empty when there is nothing to quote — the caller renders that as unavailable rather than
 * naming a likely element.
 */
export function selectorOf(node: unknown): string {
  const element = node as Element | null;
  if (!element || typeof element.tagName !== "string") return "";
  /* `className` is an `SVGAnimatedString` on SVG elements, not a string — the type check is
     what keeps an `<svg>` from rendering as `svg.[object Object]`. */
  const cls =
    typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
  const qualifier = element.id ? `#${element.id}` : cls ? `.${cls}` : "";
  return (element.tagName.toLowerCase() + qualifier).slice(0, 64);
}

/** LCP in ms, or -1 when the browser has reported none. */
let lcp = -1;
/** Time to first byte from the navigation entry, in ms. Attribution input for LCP. */
let ttfb = -1;

/* CLS is the largest session window, not a running total: shifts group into a window while
   they are within 1s of the previous shift and 5s of the window's start. */
let clsMax = 0;
let sessionValue = 0;
let sessionFirst = 0;
let sessionLast = 0;

/* INP is a high percentile of interaction latencies, not the maximum. The standard
   approximation keeps the ten longest interactions and indexes into them by the total
   interaction count, so one freak interaction on a long-lived page does not define the
   score. Bounded by construction — ten slots, never grown. */
const LONGEST = 10;
const longestLatency = new Float64Array(LONGEST);
const longestId = new Float64Array(LONGEST);
let longestCount = 0;

let loafCount = 0;
let loafLongest = 0;

/**
 * Attribution, as strings only.
 *
 * Each is derived exactly when the entry it describes takes over the vital — a new LCP, a
 * shift that sets a new maximum, an interaction that becomes the longest, a longer frame.
 * A page that reports five hundred small layout shifts derives nothing after the first few,
 * so accumulation stays bounded rather than allocating a string per entry.
 */
let lcpElement = "";
let clsSource = "";
let clsLargestShift = 0;
let inpTarget = "";
let inpTargetLatency = -1;
let loafScript = "";

export function noteLcp(entry: PerformanceEntry): void {
  /* The last LCP entry *before the seal* wins; the browser only ever reports larger.
     Candidates describing a paint after the user interacted or the page was hidden are not
     this page's LCP by the standard's definition, and taking them would make d0bar report a
     larger number than the browser's own tooling for the same load. The comparison is on the
     entry's timestamp rather than on arrival, so a `buffered: true` delivery that arrives
     after the seal still counts every candidate that happened before it — see
     `lcpSealTime()`. */
  if (entry.startTime > lcpSealTime()) return;
  lcp = entry.startTime;
  lcpElement = selectorOf((entry as LcpEntry).element);
}

export function noteNavigation(entry: PerformanceNavigationTiming): void {
  ttfb = entry.responseStart;
}

export function noteLayoutShift(entry: LayoutShiftEntry): void {
  if (entry.hadRecentInput) return;
  /* Only the single largest shift is attributed, and only when it is beaten — `sources` is
     not even read otherwise, which is what keeps five hundred shifts from costing five
     hundred selector derivations. */
  if (entry.value > clsLargestShift) {
    clsLargestShift = entry.value;
    clsSource = selectorOf(entry.sources?.[0]?.node);
  }
  if (
    sessionValue !== 0 &&
    entry.startTime - sessionLast < 1000 &&
    entry.startTime - sessionFirst < 5000
  ) {
    sessionValue += entry.value;
    sessionLast = entry.startTime;
  } else {
    sessionValue = entry.value;
    sessionFirst = entry.startTime;
    sessionLast = entry.startTime;
  }
  if (sessionValue > clsMax) clsMax = sessionValue;
}

export function noteInteraction(entry: EventTimingEntry): void {
  const id = entry.interactionId;
  if (!id) return;
  const latency = entry.duration;

  /* The longest interaction, which is not always the one INP reports — on a page with more
     than fifty interactions the score is a lower percentile. The card says which it is
     showing rather than presenting this as the scored interaction's target. */
  if (latency > inpTargetLatency) {
    inpTargetLatency = latency;
    inpTarget = selectorOf(entry.target);
  }

  /* Several event entries share one interactionId; the interaction's latency is the
     largest of them. */
  for (let i = 0; i < longestCount; i++) {
    if (longestId[i] === id) {
      if (latency > (longestLatency[i] as number)) longestLatency[i] = latency;
      return;
    }
  }

  if (longestCount < LONGEST) {
    longestLatency[longestCount] = latency;
    longestId[longestCount] = id;
    longestCount++;
    return;
  }

  /* Replace the smallest retained interaction, if this one is larger. */
  let min = 0;
  for (let i = 1; i < LONGEST; i++) {
    if ((longestLatency[i] as number) < (longestLatency[min] as number)) min = i;
  }
  if (latency > (longestLatency[min] as number)) {
    longestLatency[min] = latency;
    longestId[min] = id;
  }
}

export function noteLoaf(entry: PerformanceEntry): void {
  loafCount++;
  if (entry.duration > loafLongest) {
    loafLongest = entry.duration;
    /* The frame's dominant script, by the browser's own per-script durations. `scripts` is
       absent on browsers that report the frame but not its breakdown, and the card then
       shows the duration with no cause named. */
    const scripts = (entry as LoafEntry).scripts;
    loafScript = "";
    let longest = -1;
    for (let i = 0; scripts && i < scripts.length; i++) {
      const script = scripts[i] as { duration?: number; sourceFunctionName?: string };
      if ((script.duration ?? -1) > longest) {
        longest = script.duration ?? -1;
        loafScript = (script.sourceFunctionName ?? "").slice(0, 64);
      }
    }
  }
}

interface InteractionCounter {
  interactionCount?: number;
}

/** INP in ms, or -1 when no interaction has been recorded. */
export function inp(): number {
  if (longestCount === 0) return -1;
  const sorted = Array.from(longestLatency.subarray(0, longestCount)).sort((a, b) => b - a);
  const total = (performance as unknown as InteractionCounter).interactionCount ?? longestCount;
  const rank = Math.min(sorted.length - 1, Math.floor(total / 50));
  return sorted[rank] as number;
}

export function snapshot(): VitalsReading {
  const scored = inp();
  return {
    lcp,
    cls: clsMax,
    inp: scored,
    ttfb,
    loafCount,
    loafLongest,
    lcpElement,
    clsSource,
    inpTarget,
    /* Whether the attributed interaction is the one the score reports. False on a page with
       enough interactions for the percentile to land below the worst one. */
    inpTargetIsScored: scored >= 0 && scored === inpTargetLatency,
    loafScript,
    entryTypes: [],
  };
}


function bucket(value: number, good: number, poor: number): Bucket {
  if (value <= good) return HEALTHY;
  if (value <= poor) return WARNING;
  return POOR;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export interface WorstVital {
  name: "LCP" | "INP" | "CLS";
  text: string;
  bucket: Bucket;
}

/**
 * The vital in the worst threshold bucket, for the pill's dot and label. Ties resolve in
 * LCP, INP, CLS order — the order a developer is most likely to act on.
 *
 * Returns `undefined` when the browser has reported nothing yet; the pill then shows no
 * vital rather than a zero.
 */
export function worstVital(): WorstVital | undefined {
  const candidates: WorstVital[] = [];
  if (lcp >= 0) {
    candidates.push({
      name: "LCP",
      text: `LCP ${formatMs(lcp)}`,
      bucket: bucket(lcp, THRESHOLDS.lcp[0], THRESHOLDS.lcp[1]),
    });
  }
  const currentInp = inp();
  if (currentInp >= 0) {
    candidates.push({
      name: "INP",
      text: `INP ${formatMs(currentInp)}`,
      bucket: bucket(currentInp, THRESHOLDS.inp[0], THRESHOLDS.inp[1]),
    });
  }
  if (clsMax > 0) {
    candidates.push({
      name: "CLS",
      text: `CLS ${clsMax.toFixed(2)}`,
      bucket: bucket(clsMax, THRESHOLDS.cls[0], THRESHOLDS.cls[1]),
    });
  }
  let worst: WorstVital | undefined;
  for (const candidate of candidates) {
    if (!worst || candidate.bucket > worst.bucket) worst = candidate;
  }
  return worst;
}

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetVitals(): void {
  lcp = -1;
  ttfb = -1;
  clsMax = 0;
  sessionValue = 0;
  sessionFirst = 0;
  sessionLast = 0;
  longestLatency.fill(0);
  longestId.fill(0);
  longestCount = 0;
  loafCount = 0;
  loafLongest = 0;
  lcpElement = "";
  clsSource = "";
  clsLargestShift = 0;
  inpTarget = "";
  inpTargetLatency = -1;
  loafScript = "";
}
