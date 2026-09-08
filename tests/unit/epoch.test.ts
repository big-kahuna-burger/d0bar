// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  currentEpochId,
  epochDisclosure,
  epochSource,
  resetEpoch,
  selectTier,
} from "../../src/collector/epoch";

afterEach(resetEpoch);

describe("epoch tier selection", () => {
  it("prefers soft-navigation when the entry type is supported", () => {
    expect(selectTier({ entryTypes: ["resource", "soft-navigation"], navigation: true })).toBe(
      1,
    );
    expect(epochSource()).toBe("soft-navigation");
  });

  it("uses the Navigation API when soft-navigation is unavailable", () => {
    expect(selectTier({ entryTypes: ["resource"], navigation: true })).toBe(2);
    expect(epochSource()).toBe("navigation-api");
  });

  it("falls back to one document epoch and owns the disclosure copy", () => {
    expect(selectTier({ entryTypes: ["resource"], navigation: false })).toBe(3);
    expect(epochSource()).toBe("document");
    expect(currentEpochId()).toBe(0);
    expect(epochDisclosure()).toBe(
      "Route boundaries are unavailable on this browser; d0bar is showing the whole document.",
    );
  });

  it("freezes the first selection", () => {
    expect(selectTier({ entryTypes: ["soft-navigation"], navigation: true })).toBe(1);
    expect(selectTier({ entryTypes: [], navigation: false })).toBe(1);
    expect(epochSource()).toBe("soft-navigation");
  });

  it("does not disclose degradation for route-aware tiers", () => {
    selectTier({ entryTypes: [], navigation: true });
    expect(epochDisclosure()).toBeUndefined();
  });
});
