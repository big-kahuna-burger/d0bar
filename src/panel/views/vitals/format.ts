import type { VitalsReading } from "../../../shared/stage2";

/**
 * What a vitals card is allowed to say.
 *
 * The whole claim of this tab is provenance, so every decision that could turn an absence
 * into a plausible number is made here, in pure functions a node test can settle. The DOM
 * module only paints what these return.
 *
 * Three states, never blended:
 *
 *   entry type absent   ──▶  "unsupported"        · the browser does not report this at all
 *   supported, no entry ──▶  "not reported"       · registered, nothing delivered yet
 *   entry delivered     ──▶  the browser's number · bucketed against the standard thresholds
 *
 * There is no fourth state in which a missing measurement is drawn as `0`.
 */

export type Tone = "healthy" | "warning" | "error" | "neutral" | "unknown";

export interface Card {
  name: string;
  /** The entry type this card is read from. Named in the copy, so it is named here. */
  entryType: string;
  /** The value as displayed. A word, not a number, when there is no number to display. */
  value: string;
  tone: Tone;
  /** Always non-empty: an absence is stated in words rather than left as a blank line. */
  attribution: string;
}

const UNAVAILABLE = "attribution unavailable";

const NAMES = ["LCP", "CLS", "INP", "LoAF"];
const TYPES = ["largest-contentful-paint", "layout-shift", "event", "long-animation-frame"];

/** Standard Core Web Vitals thresholds — good, then needs-improvement. */
const GOOD = [2500, 0.1, 200, 0];
const POOR = [4000, 0.25, 500, 0];

/**
 * What each card says when the entry type is supported but has delivered nothing.
 *
 * Two of these are gaps and two are readings. LCP and INP arrive as `-1` and genuinely have
 * no value yet. CLS and LoAF arrive as zero from an observer registered with `buffered: true`
 * — a page that has not shifted and has had no long frame, which is a measurement.
 */
const NONE = [
  "The browser has reported no largest-contentful-paint entry.",
  "No layout shift has been reported.",
  "No interaction has been reported on this page yet.",
  "No long animation frame has been reported.",
];

/** `412ms` under a second, `4.53s` above it — the pill's spelling, so the two agree. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function bucket(value: number, good: number, poor: number): Tone {
  if (value <= good) return "healthy";
  if (value <= poor) return "warning";
  return "error";
}

/**
 * The four cards, in the handoff's order.
 *
 * Rebuilt on each repaint rather than diffed: four objects on a tab the user is looking at is
 * not the hot path, and the alternative — mutating a retained card — is how a stale tone
 * outlives the value it described.
 */
export function cards(reading: VitalsReading): Card[] {
  const out: Card[] = [];
  for (let i = 0; i < 4; i += 1) out.push(cardAt(reading, i));
  return out;
}

function cardAt(reading: VitalsReading, i: number): Card {
  const name = NAMES[i] as string;
  const entryType = TYPES[i] as string;

  if (reading.entryTypes.indexOf(entryType) < 0) {
    /* Names the capability and stops. Guessing at the value this browser would have
       reported is exactly the move the honest-degradation ladder forbids. */
    return {
      name,
      entryType,
      value: "unsupported",
      tone: "unknown",
      attribution: `This browser reports no ${entryType} entries.`,
    };
  }

  const raw =
    i === 0 ? reading.lcp : i === 1 ? reading.cls : i === 2 ? reading.inp : reading.loafCount;
  /* Only LCP and INP can be absent as a number; the other two are honestly zero. */
  if (raw < 0) {
    return { name, entryType, value: "not reported", tone: "unknown", attribution: nth(NONE, i) };
  }

  return {
    name,
    entryType,
    value: i === 1 ? raw.toFixed(2) : i === 3 ? String(raw) : formatMs(raw),
    /* A frame count has no good/poor boundary to bucket against, so colouring one would be
       an invention — the handoff gives it the neutral intense text for that reason. */
    tone: i === 3 ? "neutral" : bucket(raw, nth(GOOD, i), nth(POOR, i)),
    attribution: attribute(reading, i),
  };
}

function nth<T>(list: T[], i: number): T {
  return list[i] as T;
}

function attribute(reading: VitalsReading, i: number): string {
  if (i === 0) {
    const parts = [reading.lcpElement ? `element: ${reading.lcpElement}` : UNAVAILABLE];
    /* TTFB comes from the navigation entry, not the LCP one, so its absence is independent
       of the element's — a card can carry one and not the other. */
    if (reading.ttfb >= 0) parts.push(`TTFB ${formatMs(reading.ttfb)}`);
    return parts.join(" · ");
  }
  if (i === 1) {
    if (reading.clsSource) return `largest shift: ${reading.clsSource}`;
    return reading.cls === 0 ? nth(NONE, 1) : UNAVAILABLE;
  }
  if (i === 2) {
    if (!reading.inpTarget) return UNAVAILABLE;
    /* INP is a high percentile, not the maximum, so on a busy page the attributed
       interaction is not the scored one. Saying which avoids pointing a developer at an
       element the number did not come from. */
    const label = reading.inpTargetIsScored ? "target" : "longest interaction";
    return `${label}: ${reading.inpTarget}`;
  }
  if (reading.loafCount === 0) return nth(NONE, 3);
  return `longest ${formatMs(reading.loafLongest)} · ${reading.loafScript || UNAVAILABLE}`;
}

/** The card's accessible name — the same reading a sighted user gets, absences included. */
export function accessibleName(card: Card): string {
  return `${card.name} ${card.value}, ${card.attribution}`;
}
