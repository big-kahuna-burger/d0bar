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
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
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

export function noteLcp(entry: PerformanceEntry): void {
  /* The last LCP entry before finalization wins; the browser only ever reports larger. */
  lcp = entry.startTime;
}

export function noteNavigation(entry: PerformanceNavigationTiming): void {
  ttfb = entry.responseStart;
}

export function noteLayoutShift(entry: LayoutShiftEntry): void {
  if (entry.hadRecentInput) return;
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
  if (entry.duration > loafLongest) loafLongest = entry.duration;
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

export function snapshot(): {
  lcp: number;
  cls: number;
  inp: number;
  ttfb: number;
  loafCount: number;
  loafLongest: number;
} {
  return { lcp, cls: clsMax, inp: inp(), ttfb, loafCount, loafLongest };
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

/** Test seam. */
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
}
