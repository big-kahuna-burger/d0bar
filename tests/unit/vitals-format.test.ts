import { describe, expect, it } from "vitest";
import { accessibleName, bucket, cards, formatMs } from "../../src/panel/views/vitals/format";
import type { VitalsReading } from "../../src/shared/stage2";

/**
 * What a vitals card is allowed to say.
 *
 * The assertions that matter here are the absences. Every one of them is a place where a
 * plausible number could have been drawn instead — a zero for an LCP the browser never
 * reported, a green `0.00` for a browser that does not implement `layout-shift`, an element
 * name for an entry that carried none — and each is asserted rather than intended.
 */

const ALL_TYPES = ["largest-contentful-paint", "layout-shift", "event", "long-animation-frame"];

function reading(over: Partial<VitalsReading> = {}): VitalsReading {
  return {
    self: {
      mode: "unavailable",
      totalMs: 0,
      longestFrameMs: 0,
      frames: 0,
      namedFrames: 0,
      loadPhaseMs: 0,
      top: [],
    },
    lcp: -1,
    cls: 0,
    inp: -1,
    ttfb: -1,
    loafCount: 0,
    loafLongest: 0,
    lcpElement: "",
    clsSource: "",
    inpTarget: "",
    inpTargetIsScored: false,
    loafScript: "",
    entryTypes: ALL_TYPES,
    ...over,
  };
}

function card(name: string, over: Partial<VitalsReading> = {}) {
  const found = cards(reading(over)).find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} card`);
  return found;
}

describe("formatting", () => {
  it("uses milliseconds below a second and two decimals above it", () => {
    expect(formatMs(112)).toBe("112ms");
    expect(formatMs(999.4)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.00s");
    expect(formatMs(4530)).toBe("4.53s");
  });
});

describe("thresholds", () => {
  it("buckets at the boundary, not past it", () => {
    expect(bucket(2500, 2500, 4000)).toBe("healthy");
    expect(bucket(2500.1, 2500, 4000)).toBe("warning");
    expect(bucket(4000, 2500, 4000)).toBe("warning");
    expect(bucket(4000.1, 2500, 4000)).toBe("error");
  });

  it("colours LCP against the standard thresholds", () => {
    expect(card("LCP", { lcp: 2400 }).tone).toBe("healthy");
    expect(card("LCP", { lcp: 3200 }).tone).toBe("warning");
    expect(card("LCP", { lcp: 4530 }).tone).toBe("error");
  });

  it("colours INP against the standard thresholds", () => {
    expect(card("INP", { inp: 112 })).toMatchObject({ value: "112ms", tone: "healthy" });
    expect(card("INP", { inp: 260 }).tone).toBe("warning");
    expect(card("INP", { inp: 900 }).tone).toBe("error");
  });

  it("colours CLS against the standard thresholds and shows two decimals", () => {
    expect(card("CLS", { cls: 0.04 })).toMatchObject({ value: "0.04", tone: "healthy" });
    expect(card("CLS", { cls: 0.2 }).tone).toBe("warning");
    expect(card("CLS", { cls: 0.4 }).tone).toBe("error");
  });

  it("gives a frame count no threshold colour at all", () => {
    /* There is no good/poor boundary for a count, so colouring one would be an invention. */
    expect(card("LoAF", { loafCount: 3, loafLongest: 84 }).tone).toBe("neutral");
    expect(card("LoAF", { loafCount: 90, loafLongest: 900 }).tone).toBe("neutral");
  });
});

describe("absent values", () => {
  it("never renders an unreported LCP as a number", () => {
    const lcp = card("LCP", { lcp: -1 });
    expect(lcp.value).toBe("not reported");
    expect(lcp.tone).toBe("unknown");
    expect(lcp.value).not.toMatch(/\d/);
  });

  it("never renders an unreported INP as a number", () => {
    const inp = card("INP", { inp: -1 });
    expect(inp.value).toBe("not reported");
    expect(inp.tone).toBe("unknown");
  });

  it("reports an unsupported entry type as a state, not as a zero", () => {
    const noLoaf = card("LoAF", { entryTypes: ["largest-contentful-paint", "layout-shift"] });
    expect(noLoaf.value).toBe("unsupported");
    expect(noLoaf.tone).toBe("unknown");
    expect(noLoaf.attribution).toBe("This browser reports no long-animation-frame entries.");
  });

  it("does not let an unsupported vital take a healthy colour", () => {
    for (const c of cards(reading({ entryTypes: [] }))) {
      expect(c.value).toBe("unsupported");
      expect(c.tone).toBe("unknown");
    }
  });

  it("treats a zero CLS from a supported observer as a measurement, not a gap", () => {
    /* Registered with `buffered: true` and no shift delivered means the page did not
       shift. That is a reading, and it is the one case where zero is honest. */
    const cls = card("CLS", { cls: 0 });
    expect(cls.value).toBe("0.00");
    expect(cls.tone).toBe("healthy");
    expect(cls.attribution).toBe("No layout shift has been reported.");
  });

  it("omits TTFB rather than showing a zero for it", () => {
    expect(card("LCP", { lcp: 2400, lcpElement: "img.hero", ttfb: -1 }).attribution).toBe(
      "element: img.hero",
    );
    expect(card("LCP", { lcp: 2400, lcpElement: "img.hero", ttfb: 1900 }).attribution).toBe(
      "element: img.hero · TTFB 1.90s",
    );
  });
});

describe("attribution", () => {
  it("quotes the element the entry carried", () => {
    expect(card("LCP", { lcp: 4530, lcpElement: "img.hero-map", ttfb: 1900 }).attribution).toBe(
      "element: img.hero-map · TTFB 1.90s",
    );
    expect(card("CLS", { cls: 0.04, clsSource: "div.rate-table" }).attribution).toBe(
      "largest shift: div.rate-table",
    );
  });

  it("states that attribution is unavailable rather than naming a likely element", () => {
    expect(card("LCP", { lcp: 4530 }).attribution).toBe("attribution unavailable");
    expect(card("CLS", { cls: 0.4 }).attribution).toBe("attribution unavailable");
    expect(card("INP", { inp: 260 }).attribution).toBe("attribution unavailable");
    expect(card("LoAF", { loafCount: 3, loafLongest: 84 }).attribution).toBe(
      "longest 84ms · attribution unavailable",
    );
  });

  it("says when the attributed interaction is not the scored one", () => {
    expect(
      card("INP", { inp: 112, inpTarget: "button.confirm-hold", inpTargetIsScored: true })
        .attribution,
    ).toBe("target: button.confirm-hold");
    /* On a busy page INP is a percentile, so the longest interaction is a different one and
       pointing at it as "the target" would send a developer to the wrong element. */
    expect(
      card("INP", { inp: 112, inpTarget: "button.confirm-hold", inpTargetIsScored: false })
        .attribution,
    ).toBe("longest interaction: button.confirm-hold");
  });

  it("names the dominant script of the longest frame", () => {
    expect(
      card("LoAF", { loafCount: 3, loafLongest: 84, loafScript: "renderQuote" }).attribution,
    ).toBe("longest 84ms · renderQuote");
  });
});

describe("accessible name", () => {
  it("carries the absence, not just the value", () => {
    expect(accessibleName(card("LCP", { lcp: -1 }))).toBe(
      "LCP not reported, The browser has reported no largest-contentful-paint entry.",
    );
  });

  it("carries the value and its attribution", () => {
    expect(
      accessibleName(card("LCP", { lcp: 4530, lcpElement: "img.hero-map", ttfb: 1900 })),
    ).toBe("LCP 4.53s, element: img.hero-map · TTFB 1.90s");
  });
});

describe("card set", () => {
  it("is the four the handoff lists, in order", () => {
    expect(cards(reading()).map((c) => c.name)).toEqual(["LCP", "CLS", "INP", "LoAF"]);
  });

  it("always states an attribution line, never a blank one", () => {
    for (const c of cards(reading())) expect(c.attribution.length).toBeGreaterThan(0);
    for (const c of cards(reading({ entryTypes: [] }))) {
      expect(c.attribution.length).toBeGreaterThan(0);
    }
  });
});
