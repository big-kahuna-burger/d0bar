import { beforeEach, describe, expect, it } from "vitest";
import { parseAndReplayEntryDump, parseEntryDump } from "../../bench/replay-entry-dump";
import { read, resetRing, scratch, size } from "../../src/collector/ring";
import { resetIntern } from "../../src/shared/intern";

const resource = {
  name: "https://shop.example.test/api/cart",
  entryType: "resource",
  initiatorType: "fetch",
  startTime: 20,
  duration: 30,
  connectStart: 21,
  requestStart: 24,
  responseStart: 42,
  responseEnd: 50,
  transferSize: 800,
  encodedBodySize: 600,
};

describe("recorded entry replay", () => {
  beforeEach(() => {
    resetIntern();
    resetRing({ statusSupported: false, deliverySupported: false });
  });

  it("replays resources through the production ring in arrival order", () => {
    const dump = JSON.stringify({
      recordedAt: "2026-09-08T00:00:00.000Z",
      userAgent: "fixture",
      resource: [
        resource,
        { ...resource, name: "https://shop.example.test/app.js", startTime: 55 },
      ],
      "layout-shift": [{ value: 0.01 }],
    });

    const parsed = parseAndReplayEntryDump(dump);

    expect(parsed["layout-shift"]).toEqual([{ value: 0.01 }]);
    expect(size()).toBe(2);
    expect(read(0, scratch())?.url).toBe("https://shop.example.test/api/cart");
    expect(read(1, scratch())?.startTime).toBe(55);
  });

  it("rejects an incomplete resource instead of writing NaN into the ring", () => {
    const incomplete = JSON.stringify({ resource: [{ ...resource, responseEnd: undefined }] });
    expect(() => parseEntryDump(incomplete)).toThrow("invalid responseEnd");
    expect(size()).toBe(0);
  });
});
