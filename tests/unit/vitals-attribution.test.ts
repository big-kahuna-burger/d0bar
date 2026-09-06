import { beforeEach, describe, expect, it } from "vitest";
import {
  noteInteraction,
  noteLayoutShift,
  noteLcp,
  noteLoaf,
  resetVitals,
  selectorOf,
  snapshot,
} from "../../src/collector/vitals";

/**
 * Attribution capture, and the two properties that make it safe to run inside a
 * `PerformanceObserver` callback on someone else's page.
 *
 * **Nothing is retained.** The entry's `element`, a shift's `sources[i].node` and an event's
 * `target` are live DOM nodes. A module-level variable holding one keeps a detached subtree
 * alive for the life of the page — a leak introduced by the tool that exists to find them.
 * Asserted by walking the snapshot for anything that is not a primitive.
 *
 * **Work is bounded.** The selector never leaves the element it was given, and a shift that
 * does not set a new maximum does not have its `sources` read at all. Both are asserted with
 * accessors that record or throw, so a regression fails rather than merely costs.
 */

/** A stand-in element. `parentElement` throws: reaching for it is a tree walk. */
function element(over: { tagName?: string; id?: string; className?: string } = {}) {
  const node = {
    tagName: over.tagName ?? "DIV",
    id: over.id ?? "",
    className: over.className ?? "",
    get parentElement(): never {
      throw new Error("selectorOf walked the tree");
    },
    get parentNode(): never {
      throw new Error("selectorOf walked the tree");
    },
  };
  return node as unknown as Element;
}

function shift(startTime: number, value: number, node?: unknown, hadRecentInput = false) {
  return {
    startTime,
    value,
    hadRecentInput,
    duration: 0,
    sources: node === undefined ? undefined : [{ node }],
  } as unknown as PerformanceEntry & { value: number; hadRecentInput: boolean };
}

describe("selectorOf", () => {
  beforeEach(resetVitals);

  it("prefers an id and otherwise takes the first class", () => {
    expect(selectorOf(element({ tagName: "IMG", id: "hero" }))).toBe("img#hero");
    expect(selectorOf(element({ tagName: "IMG", className: "hero-map wide" }))).toBe(
      "img.hero-map",
    );
    expect(selectorOf(element({ tagName: "BUTTON" }))).toBe("button");
  });

  it("returns empty for anything that is not an element", () => {
    expect(selectorOf(undefined)).toBe("");
    expect(selectorOf(null)).toBe("");
    expect(selectorOf({})).toBe("");
    /* An SVG element's `className` is an `SVGAnimatedString`, not a string. */
    expect(selectorOf({ tagName: "svg", id: "", className: { baseVal: "chart" } })).toBe("svg");
  });

  it("never walks past the element it was given", () => {
    /* The accessors above throw. Reaching an ancestor is O(depth) inside an observer
       callback on the page being measured, which is the cost this rules out. */
    expect(() => selectorOf(element({ className: "a" }))).not.toThrow();
  });

  it("is bounded in length", () => {
    const long = selectorOf(element({ tagName: "DIV", id: "x".repeat(400) }));
    expect(long.length).toBeLessThanOrEqual(64);
  });
});

describe("attribution capture", () => {
  beforeEach(resetVitals);

  it("quotes the LCP entry's element", () => {
    noteLcp({ startTime: 4530, element: element({ tagName: "IMG", className: "hero-map" }) } as
      unknown as PerformanceEntry);
    expect(snapshot().lcpElement).toBe("img.hero-map");
  });

  it("leaves the element empty when the entry carried none", () => {
    noteLcp({ startTime: 4530 } as PerformanceEntry);
    expect(snapshot().lcpElement).toBe("");
  });

  it("attributes CLS to the largest single shift, not the last one", () => {
    noteLayoutShift(shift(1000, 0.03, element({ tagName: "DIV", className: "rate-table" })));
    noteLayoutShift(shift(1200, 0.01, element({ tagName: "SPAN", className: "footer" })));
    expect(snapshot().clsSource).toBe("div.rate-table");
  });

  it("ignores the source of a shift that followed user input", () => {
    noteLayoutShift(shift(1000, 0.9, element({ tagName: "DIV", id: "modal" }), true));
    expect(snapshot().clsSource).toBe("");
    expect(snapshot().cls).toBe(0);
  });

  it("quotes the target of the longest interaction", () => {
    noteInteraction({ interactionId: 1, duration: 48, target: element({ tagName: "A" }) } as
      unknown as PerformanceEntry & { interactionId: number; processingStart: number });
    noteInteraction({
      interactionId: 2,
      duration: 112,
      target: element({ tagName: "BUTTON", className: "confirm-hold" }),
    } as unknown as PerformanceEntry & { interactionId: number; processingStart: number });
    const reading = snapshot();
    expect(reading.inpTarget).toBe("button.confirm-hold");
    /* Under fifty interactions the score is the worst one, so the attributed target is the
       scored target and the card may say `target:` rather than `longest interaction:`. */
    expect(reading.inpTargetIsScored).toBe(true);
  });

  it("names the dominant script of the longest frame", () => {
    noteLoaf({
      duration: 84,
      scripts: [
        { duration: 12, sourceFunctionName: "tick" },
        { duration: 61, sourceFunctionName: "renderQuote" },
      ],
    } as unknown as PerformanceEntry);
    noteLoaf({ duration: 51, scripts: [{ duration: 40, sourceFunctionName: "other" }] } as
      unknown as PerformanceEntry);
    const reading = snapshot();
    expect(reading.loafLongest).toBe(84);
    expect(reading.loafScript).toBe("renderQuote");
  });

  it("leaves the script empty when the browser reports the frame but not its breakdown", () => {
    noteLoaf({ duration: 84 } as PerformanceEntry);
    expect(snapshot().loafScript).toBe("");
  });
});

describe("accumulation is bounded and retains nothing", () => {
  beforeEach(resetVitals);

  it("retains no object of any kind, so no DOM node can survive the callback", () => {
    noteLcp({ startTime: 4530, element: element({ tagName: "IMG", id: "hero" }) } as
      unknown as PerformanceEntry);
    noteLayoutShift(shift(1000, 0.4, element({ tagName: "DIV", id: "table" })));
    noteInteraction({ interactionId: 1, duration: 112, target: element({ tagName: "BUTTON" }) } as
      unknown as PerformanceEntry & { interactionId: number; processingStart: number });
    noteLoaf({ duration: 84, scripts: [{ duration: 61, sourceFunctionName: "render" }] } as
      unknown as PerformanceEntry);

    const reading = snapshot();
    for (const [key, value] of Object.entries(reading)) {
      if (key === "entryTypes") continue;
      expect(typeof value, `${key} is not a primitive`).not.toBe("object");
    }
  });

  it("does not read a shift's sources unless the shift sets a new maximum", () => {
    let reads = 0;
    function probe(value: number, startTime: number) {
      return {
        startTime,
        value,
        hadRecentInput: false,
        duration: 0,
        get sources() {
          reads += 1;
          return [{ node: element({ tagName: "DIV" }) }];
        },
      } as unknown as PerformanceEntry & { value: number; hadRecentInput: boolean };
    }

    noteLayoutShift(probe(0.05, 0));
    expect(reads).toBe(1);
    /* Five hundred shifts, none larger. A selector derived per entry would be five hundred
       string allocations inside an observer callback on the page being measured. */
    for (let i = 1; i <= 500; i += 1) noteLayoutShift(probe(0.01, i * 10));
    expect(reads).toBe(1);
  });
});
