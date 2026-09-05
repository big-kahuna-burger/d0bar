import { beforeEach, describe, expect, it } from "vitest";
import { ABSENT, OVERFLOW, intern, internStats, resetIntern, str } from "../../src/shared/intern";

describe("intern", () => {
  beforeEach(resetIntern);

  it("returns a stable id for the same string", () => {
    const a = intern("/api/shipments");
    const b = intern("/api/shipments");
    expect(a).toBe(b);
    expect(str(a)).toBe("/api/shipments");
  });

  it("reserves 0 for absent and 1 for saturation", () => {
    expect(intern("")).toBe(ABSENT);
    expect(intern("/first")).toBeGreaterThan(OVERFLOW);
  });

  it("round-trips every interned value", () => {
    const urls = ["/a", "/b", "/c?x=1", "https://cdn.example.com/v3"];
    const ids = urls.map(intern);
    expect(ids.map(str)).toEqual(urls);
  });

  it("resolves unknown ids to the empty string rather than throwing", () => {
    expect(str(99_999)).toBe("");
  });

  it("saturates instead of growing without bound", () => {
    const { capacity } = internStats();
    for (let i = 0; i < capacity + 100; i++) intern(`/url/${i}`);

    const stats = internStats();
    expect(stats.size).toBe(capacity);
    expect(stats.overflows).toBeGreaterThan(0);
    /* A page that mints thousands of distinct URLs must not be able to grow the toolbar's
       memory. Past the cap identity is dropped, not retained. */
    expect(intern("/url/definitely-new")).toBe(OVERFLOW);
  });
});
