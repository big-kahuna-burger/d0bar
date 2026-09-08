import { describe, expect, it } from "vitest";
import { reduce } from "../src/attribution";

const match = (url: string): boolean => url.includes("subject.js");

describe("trace reduction", () => {
  it("deduplicates nested calls and sums separate entries in one task", () => {
    const result = reduce(
      [
        { name: "RunTask", ts: 0, dur: 20_000 },
        { name: "FunctionCall", ts: 1_000, dur: 5_000, args: { data: { url: "/subject.js" } } },
        { name: "FunctionCall", ts: 2_000, dur: 1_000, args: { data: { url: "/subject.js" } } },
        {
          name: "EvaluateScript",
          ts: 8_000,
          dur: 2_000,
          args: { data: { url: "/subject.js" } },
        },
      ],
      match,
    );
    expect(result.taskMs).toEqual([7]);
    expect(result.totalMs).toBe(7);
  });

  it("keeps a matched call without an enclosing task in its own bucket", () => {
    const result = reduce(
      [{ name: "FunctionCall", ts: 4_000, dur: 1_500, args: { data: { url: "/subject.js" } } }],
      match,
    );
    expect(result.taskMs).toEqual([1.5]);
    expect(result.taskCount).toBe(0);
  });

  it("returns an empty measurement for an empty trace", () => {
    expect(reduce([], match)).toEqual({
      maxTaskMs: 0,
      taskMs: [],
      totalMs: 0,
      maxAnyTaskMs: 0,
      taskCount: 0,
    });
  });
});
