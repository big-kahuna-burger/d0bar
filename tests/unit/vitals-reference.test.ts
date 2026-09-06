import { beforeEach, describe, expect, it } from "vitest";
import {
  inp,
  noteInteraction,
  noteLayoutShift,
  noteLcp,
  noteLoaf,
  resetVitals,
  snapshot,
} from "../../src/collector/vitals";
import { noteFirstInput, noteVisibilityState, resetPhase } from "../../src/collector/phase";
import dump from "../fixtures/vitals-entries.json";

/**
 * The accumulator against a real entry dump and an independent reference implementation.
 *
 * Two halves, and neither is worth much alone. A reference implementation checked only against
 * hand-written entries proves that two functions agree about a shape the browser may never
 * produce; a recorded dump with nothing to check it against proves only that the code ran.
 * `scripts/record-vitals-fixture.mjs` captures the dump from the bench fixture in the `off`
 * arm — real paints, a real layout shift with three sources, real clicks with interaction ids.
 *
 * The reference below is written from the standard definitions rather than from
 * `vitals.ts` — deriving it from the implementation would make this a test that the code
 * equals itself.
 *
 * **What this dump is thin on, stated rather than glossed:** one layout shift, so it exercises
 * CLS's session-window *grouping* not at all. That logic is covered synthetically in
 * `vitals.test.ts`, which can produce the gap and overflow cases a real page rarely does.
 */

interface RecordedShift {
  startTime: number;
  duration: number;
  value: number;
  hadRecentInput: boolean;
  sources: Array<{ node: string }>;
}
interface RecordedEvent {
  startTime: number;
  duration: number;
  interactionId: number;
  processingStart: number;
  target: string;
}
interface RecordedLcp {
  startTime: number;
  duration: number;
  element: string;
}
interface RecordedLoaf {
  startTime: number;
  duration: number;
  scripts: Array<{ duration: number; sourceFunctionName: string }>;
}

const lcpEntries = dump["largest-contentful-paint"] as RecordedLcp[];
const shifts = dump["layout-shift"] as RecordedShift[];
const events = dump["event"] as RecordedEvent[];
const loafs = dump["long-animation-frame"] as RecordedLoaf[];

/* The recorder cannot put a live node in JSON, so it stores the selector d0bar would derive.
   Replaying gives the accumulator something `selectorOf` reads the same string back out of. */
function asNode(selector: string): { tagName: string; id: string; className: string } | null {
  if (!selector) return null;
  const [tag = "", rest = ""] = selector.split(/([#.].*)/);
  return {
    tagName: tag.toUpperCase(),
    id: rest.startsWith("#") ? rest.slice(1) : "",
    className: rest.startsWith(".") ? rest.slice(1) : "",
  };
}

function replay(): void {
  for (const entry of lcpEntries) {
    noteLcp({ ...entry, element: asNode(entry.element) } as unknown as PerformanceEntry);
  }
  for (const entry of shifts) {
    noteLayoutShift({
      ...entry,
      sources: entry.sources.map((source) => ({ node: asNode(source.node) })),
    } as never);
  }
  for (const entry of events) {
    noteInteraction({ ...entry, target: asNode(entry.target) } as never);
  }
  for (const entry of loafs) noteLoaf(entry as unknown as PerformanceEntry);
}

/* ── the reference implementation ──
   Written from the definitions, not from vitals.ts. */

/** LCP is the largest reported candidate; the browser only ever raises it. */
function referenceLcp(): number {
  return lcpEntries.reduce((largest, entry) => Math.max(largest, entry.startTime), -1);
}

/**
 * CLS: the largest *session window*. A shift joins the open window while it is within 1 s of
 * the previous shift and 5 s of the window's start; shifts following recent input are excluded
 * entirely.
 */
function referenceCls(): number {
  let max = 0;
  let value = 0;
  let first = 0;
  let last = 0;
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    const joins = value !== 0 && shift.startTime - last < 1000 && shift.startTime - first < 5000;
    if (joins) {
      value += shift.value;
      last = shift.startTime;
    } else {
      value = shift.value;
      first = shift.startTime;
      last = shift.startTime;
    }
    if (value > max) max = value;
  }
  return max;
}

/**
 * INP: interactions are groups of event entries sharing an `interactionId`, and an
 * interaction's latency is the largest duration in its group. The score is the
 * `floor(count / 50)`-th longest, so a long-lived page is not defined by one freak interaction.
 *
 * Entries with no `interactionId` are not interactions and take no part.
 *
 * `performance.interactionCount` does not exist under jsdom, so both this and the accumulator
 * fall back to the number of interactions actually seen — which is the same number here, since
 * this dump has fewer than the ten the accumulator retains.
 */
function referenceInp(): number {
  const byInteraction = new Map<number, number>();
  for (const entry of events) {
    if (!entry.interactionId) continue;
    const previous = byInteraction.get(entry.interactionId) ?? 0;
    if (entry.duration > previous) byInteraction.set(entry.interactionId, entry.duration);
  }
  if (byInteraction.size === 0) return -1;
  const sorted = [...byInteraction.values()].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(byInteraction.size / 50))] as number;
}

describe("vitals against a recorded dump", () => {
  beforeEach(() => {
    resetVitals();
    resetPhase();
  });

  it("has a dump with something in it", () => {
    /* A dump that lost its contents would make every assertion below vacuously true. The
       first version of the recorder produced exactly that — `getEntriesByType` returns
       nothing for the three observer-only types. */
    expect(lcpEntries.length).toBeGreaterThan(0);
    expect(shifts.length).toBeGreaterThan(0);
    expect(events.filter((entry) => entry.interactionId).length).toBeGreaterThan(0);
    expect(loafs.length).toBeGreaterThan(0);
  });

  it("matches the reference implementation on every vital", () => {
    replay();
    const reading = snapshot();
    expect(reading.lcp).toBe(referenceLcp());
    expect(reading.cls).toBeCloseTo(referenceCls(), 12);
    expect(inp()).toBe(referenceInp());
    expect(reading.loafCount).toBe(loafs.length);
    expect(reading.loafLongest).toBe(
      loafs.reduce((longest, entry) => Math.max(longest, entry.duration), 0),
    );
  });

  it("quotes attribution from the entries rather than deriving it", () => {
    replay();
    const reading = snapshot();

    const largestLcp = lcpEntries.reduce((a, b) => (b.startTime >= a.startTime ? b : a));
    expect(reading.lcpElement).toBe(largestLcp.element);

    const largestShift = shifts
      .filter((shift) => !shift.hadRecentInput)
      .reduce((a, b) => (b.value > a.value ? b : a));
    /* The first source only. A shift with three of them names the one the browser put first;
       naming all three would be the toolbar deciding which mattered. */
    expect(reading.clsSource).toBe(largestShift.sources[0]?.node ?? "");
  });

  it("reports no interaction where the dump has none with an id", () => {
    resetVitals();
    for (const entry of events.filter((e) => !e.interactionId)) {
      noteInteraction({ ...entry, target: asNode(entry.target) } as never);
    }
    expect(inp()).toBe(-1);
  });
});

describe("LCP stops accruing at the seal", () => {
  beforeEach(() => {
    resetVitals();
    resetPhase();
  });

  const early = lcpEntries[0]!;
  const late = lcpEntries[lcpEntries.length - 1]!;
  const asEntry = (entry: RecordedLcp) =>
    ({ ...entry, element: asNode(entry.element) }) as unknown as PerformanceEntry;

  it("takes the largest candidate while nothing has sealed it", () => {
    replay();
    expect(snapshot().lcp).toBe(late.startTime);
    expect(snapshot().lcpElement).toBe(late.element);
  });

  it("ignores a candidate painted after the first interaction", () => {
    noteLcp(asEntry(early));
    noteFirstInput((early.startTime + late.startTime) / 2);
    noteLcp(asEntry(late));
    expect(snapshot().lcp).toBe(early.startTime);
    expect(snapshot().lcpElement).toBe(early.element);
  });

  it("ignores a candidate painted after the page was hidden", () => {
    noteLcp(asEntry(early));
    noteVisibilityState("hidden", (early.startTime + late.startTime) / 2);
    noteLcp(asEntry(late));
    expect(snapshot().lcp).toBe(early.startTime);
  });

  /**
   * The reason the seal is a timestamp and not a boolean.
   *
   * Observers are registered with `buffered: true`, so a toolbar mounting after an interaction
   * receives every candidate the page ever produced, all of them at once and all of them after
   * the seal. A boolean seal drops the lot and reports no LCP at all on a page that plainly had
   * one.
   */
  it("keeps buffered candidates that describe paints from before the seal", () => {
    noteFirstInput(late.startTime + 1);
    replay();
    expect(snapshot().lcp).toBe(late.startTime);
  });

  it("seals at the earliest of interaction and hidden, not the latest", () => {
    noteVisibilityState("hidden", early.startTime + 1);
    noteFirstInput(late.startTime + 1);
    noteLcp(asEntry(late));
    expect(snapshot().lcp).toBe(-1);
  });

  /**
   * The quiet timer is not a seal.
   *
   * `phase.ts` also finalizes LCP on a quiet period after load, which is d0bar's own heuristic
   * for lifting the moratorium and is not in the standard's definition of LCP. A page that
   * paints something larger with nobody touching it has a larger LCP, and sealing there would
   * report a smaller number than the browser's own tooling for the same load.
   */
  it("does not seal merely because the moratorium lifted", async () => {
    const { settleNow, currentPhase } = await import("../../src/collector/phase");
    noteLcp(asEntry(early));
    settleNow();
    expect(currentPhase()).toBe("settled");
    noteLcp(asEntry(late));
    expect(snapshot().lcp).toBe(late.startTime);
  });
});
