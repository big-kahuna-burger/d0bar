import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUT_PROTOCOL_VERSION, layoutViews } from "../../src/shared/protocol";
import { layout } from "../../src/worker/layout";

describe("the handoff's small trace fixture", () => {
  it("flattens to the seven specified rows and three correlated logs", () => {
    const body = readFileSync(join(process.cwd(), "bench/fixtures/trace-small.json"), "utf8");
    const result = layout({
      kind: "layout",
      version: LAYOUT_PROTOCOL_VERSION,
      id: 1,
      body,
      from: 0,
      to: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.spanCount).toBe(7);
    expect(result.summary.logCount).toBe(3);
    expect(result.logs).toHaveLength(3);

    const views = layoutViews(result.buffer, result.count);
    const names = Array.from(views.nameId, (id) => result.strings[id]);
    expect(names).toEqual([
      "GET /shipments/8821",
      "HTTP GET /api/shipments",
      "GET /shipments",
      "SELECT shipments",
      "GET /rates/{corridor}",
      "GET rate:eu:nl-de",
      "SELECT tariffs",
    ]);
  });
});
