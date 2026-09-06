// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_MARK,
  beginSelfCost,
  noteSelfLoaf,
  resetSelfCost,
  selfCost,
} from "../../src/collector/selfcost";
import { resetPhase, settleNow } from "../../src/collector/phase";
import { setStage2Url } from "../../src/shared/stage2";

/**
 * Tier 0's arithmetic, away from a browser.
 *
 * The property under test is not "the numbers add up" — it is that the three attribution modes stay
 * distinguishable, because the whole value of this module is that a floor, an exact reading and no
 * reading at all are different claims. A version that collapsed them would still add up.
 *
 * Both URLs are passed explicitly. Under vitest `import.meta.url` resolves to a real file URL, so
 * the default would always be `url` and the bundled case — the hard one — would be unreachable.
 */

const OWN = "https://cdn.example.com/d0bar.iife.js";
const PAGE = "https://shop.example.com/checkout";

function loaf(
  scripts: Array<{ sourceURL?: string; sourceFunctionName?: string; duration: number }>,
) {
  return {
    entryType: "long-animation-frame",
    duration: 120,
    scripts,
  } as unknown as PerformanceEntry;
}

afterEach(() => {
  resetSelfCost();
  resetPhase();
  setStage2Url(undefined);
});

describe("attribution mode", () => {
  it("reports unavailable when the browser has no long-animation-frame", () => {
    beginSelfCost(false, OWN, PAGE);
    expect(selfCost().mode).toBe("unavailable");
  });

  it("charges nothing at all when unavailable, rather than zero", () => {
    beginSelfCost(false, OWN, PAGE);
    noteSelfLoaf(
      loaf([{ sourceURL: PAGE, sourceFunctionName: `${SELF_MARK}tick`, duration: 9 }]),
    );
    /* The figure is zero either way; the mode is what stops the footer printing it as a
       measurement. This asserts the mode survives an entry arriving. */
    expect(selfCost()).toEqual({
      mode: "unavailable",
      totalMs: 0,
      longestFrameMs: 0,
      frames: 0,
      namedFrames: 0,
      loadPhaseMs: 0,
      top: [],
    });
  });

  it("attributes by URL when its own script is distinguishable", () => {
    beginSelfCost(true, OWN, PAGE);
    expect(selfCost().mode).toBe("url");
  });

  it("falls back to a lower bound when its own URL is the document's", () => {
    beginSelfCost(true, PAGE, PAGE);
    expect(selfCost().mode).toBe("lower-bound");
  });

  it("falls back to a lower bound when it cannot resolve its own URL at all", () => {
    beginSelfCost(true, "", PAGE);
    expect(selfCost().mode).toBe("lower-bound");
  });
});

describe("lower-bound attribution", () => {
  it("counts only what a reserved name proves", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(
      loaf([
        { sourceURL: PAGE, sourceFunctionName: "renderQuote", duration: 40 },
        { sourceURL: PAGE, sourceFunctionName: `${SELF_MARK}refresh`, duration: 3 },
      ]),
    );
    /* The host's 40 ms is in the same frame under the same URL and is not ours to claim. */
    expect(selfCost().totalMs).toBe(3);
    expect(selfCost().frames).toBe(1);
  });

  it("ignores a frame with no d0bar script in it", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(loaf([{ sourceURL: PAGE, sourceFunctionName: "renderQuote", duration: 90 }]));
    expect(selfCost()).toMatchObject({ totalMs: 0, frames: 0 });
  });

  it("keeps the longest single frame, not the longest run of frames", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}a`, duration: 2 }]));
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}b`, duration: 5 }]));
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}c`, duration: 1 }]));
    expect(selfCost()).toMatchObject({ totalMs: 8, longestFrameMs: 5, frames: 3 });
  });

  it("sums several d0bar scripts within one frame", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(
      loaf([
        { sourceFunctionName: `${SELF_MARK}refresh`, duration: 2 },
        { sourceFunctionName: "hostWork", duration: 30 },
        { sourceFunctionName: `${SELF_MARK}flush`, duration: 4 },
      ]),
    );
    expect(selfCost()).toMatchObject({ totalMs: 6, longestFrameMs: 6, frames: 1 });
  });

  it("survives a frame the browser delivered without a script breakdown", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf({ entryType: "long-animation-frame", duration: 200 } as PerformanceEntry);
    expect(selfCost()).toMatchObject({ totalMs: 0, frames: 0 });
  });
});

describe("the load-phase share", () => {
  it("is charged separately, so a moratorium breach cannot hide in the total", () => {
    beginSelfCost(true, PAGE, PAGE);
    /* Still collecting: `resetPhase` left the phase at `collecting` and nothing has settled. */
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}early`, duration: 7 }]));
    settleNow();
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}late`, duration: 3 }]));
    const cost = selfCost();
    expect(cost.totalMs).toBe(10);
    /* The number the moratorium is supposed to keep at zero, visible on its own rather than
       buried inside a total that a busy panel would dominate. */
    expect(cost.loadPhaseMs).toBe(7);
  });

  it("is zero when every frame arrived after settle", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}late`, duration: 3 }]));
    expect(selfCost().loadPhaseMs).toBe(0);
  });
});

describe("teardown", () => {
  it("forgets everything, so a second init does not describe two pages", () => {
    beginSelfCost(true, PAGE, PAGE);
    settleNow();
    noteSelfLoaf(loaf([{ sourceFunctionName: `${SELF_MARK}a`, duration: 5 }]));
    resetSelfCost();
    expect(selfCost()).toEqual({
      mode: "unavailable",
      totalMs: 0,
      longestFrameMs: 0,
      frames: 0,
      namedFrames: 0,
      loadPhaseMs: 0,
      top: [],
    });
  });
});
