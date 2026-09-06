import { beforeEach, describe, expect, it } from "vitest";
import {
  noteInteraction,
  noteLayoutShift,
  noteLcp,
  resetVitals,
  snapshot,
} from "../../src/collector/vitals";
import { resetPhase } from "../../src/collector/phase";

/**
 * What accumulating five hundred entries costs, and what it must not do.
 *
 * ## Why this is not a heap measurement
 *
 * The requirement is *"no per-entry object survives the callback"*, and the obvious instrument
 * for it — force a GC, diff `heapUsed` — needs `--expose-gc`, which `pnpm test` does not pass.
 * A test that skips itself when the flag is absent would be green on every machine that has
 * never run it, which is the shape of dishonesty this repo exists to avoid.
 *
 * So the property is asserted where it is actually decided, deterministically and with no
 * flags. Every allocation on this path comes from one place: `selectorOf`, which builds a
 * string. `vitals.ts` claims it is reached only when an entry *takes over* its vital, and that
 * claim is checkable directly — hand the accumulator sources whose `node` is a counted getter
 * and see how many times it is read. Five hundred shifts that beat nothing must read zero.
 *
 * Retention is checked the same way: mutate the node after accumulating, and the snapshot must
 * not move. A stored node would follow; a derived string cannot.
 *
 * ## The number
 *
 * Timing here is Node's, not a browser's, and the accumulator is the same code either way. It
 * is recorded rather than gated — see `bench/budget.json` — because a per-entry cost in the
 * tens of nanoseconds is dominated by whatever else the machine is doing.
 */

const ENTRIES = 500;

/** A node that counts every read of the property `selectorOf` would touch first. */
function countingNode(counter: { reads: number }) {
  return {
    get tagName() {
      counter.reads += 1;
      return "DIV";
    },
    id: "",
    className: "",
  };
}

function shiftWith(startTime: number, value: number, node: unknown) {
  return {
    startTime,
    duration: 0,
    value,
    hadRecentInput: false,
    sources: [{ node }],
  } as never;
}

describe("vitals accumulation", () => {
  beforeEach(() => {
    resetVitals();
    resetPhase();
  });

  it("derives a selector only for a shift that takes over the vital", () => {
    const counter = { reads: 0 };
    /* One large shift first, then 499 that beat nothing. */
    noteLayoutShift(shiftWith(0, 0.5, countingNode(counter)));
    const afterFirst = counter.reads;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 1; i < ENTRIES; i += 1) {
      noteLayoutShift(shiftWith(i * 10, 0.0001, countingNode(counter)));
    }

    expect(
      counter.reads,
      `${counter.reads - afterFirst} selector derivations across ${ENTRIES - 1} shifts that set no new maximum`,
    ).toBe(afterFirst);
  });

  it("reads no source at all from a shift following recent input", () => {
    const counter = { reads: 0 };
    for (let i = 0; i < ENTRIES; i += 1) {
      noteLayoutShift({
        startTime: i * 10,
        duration: 0,
        value: 1,
        hadRecentInput: true,
        sources: [{ node: countingNode(counter) }],
      } as never);
    }
    expect(counter.reads).toBe(0);
    expect(snapshot().cls).toBe(0);
  });

  it("retains no node from any of the three attributed entry types", () => {
    const shiftNode = { tagName: "TABLE", id: "", className: "rates" };
    const lcpNode = { tagName: "IMG", id: "hero", className: "" };
    const eventNode = { tagName: "BUTTON", id: "", className: "confirm" };

    noteLayoutShift(shiftWith(0, 0.5, shiftNode));
    noteLcp({ startTime: 100, duration: 0, element: lcpNode } as unknown as PerformanceEntry);
    noteInteraction({
      startTime: 200,
      duration: 90,
      interactionId: 7,
      processingStart: 200,
      target: eventNode,
    } as never);

    const before = snapshot();
    expect(before.clsSource).toBe("table.rates");
    expect(before.lcpElement).toBe("img#hero");
    expect(before.inpTarget).toBe("button.confirm");

    /* If any of those were stored as nodes rather than derived to strings, renaming them here
       would rewrite the attribution the panel is about to show. */
    shiftNode.className = "mutated";
    lcpNode.id = "mutated";
    eventNode.className = "mutated";

    const after = snapshot();
    expect(after.clsSource).toBe("table.rates");
    expect(after.lcpElement).toBe("img#hero");
    expect(after.inpTarget).toBe("button.confirm");
  });

  it("holds a bounded number of interactions however many arrive", () => {
    for (let i = 1; i <= ENTRIES; i += 1) {
      noteInteraction({
        startTime: i,
        duration: i,
        interactionId: i,
        processingStart: i,
        target: null,
      } as never);
    }
    /* Ten slots, preallocated, never grown — so the worst interaction is still the worst. */
    expect(snapshot().inp).toBe(ENTRIES);
  });

  it("costs a bounded amount per entry", () => {
    const shifts = Array.from({ length: ENTRIES }, (_, i) =>
      shiftWith(i * 10, 0.0001, { tagName: "DIV", id: "", className: "" }),
    );
    /* One warm pass discarded, so the measurement is not the first-call compile. */
    for (const entry of shifts) noteLayoutShift(entry);
    resetVitals();

    const started = performance.now();
    for (const entry of shifts) noteLayoutShift(entry);
    const perEntryUs = ((performance.now() - started) / ENTRIES) * 1000;

    /* Generously above anything this path can legitimately reach; what it catches is a
       category change — a selector derived per entry, a source array copied — not drift. The
       observed figure is recorded in bench/budget.json rather than gated here. */
    expect(perEntryUs, `${perEntryUs.toFixed(3)} µs per layout-shift entry`).toBeLessThan(5);
  });
});
