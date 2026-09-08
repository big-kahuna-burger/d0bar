import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetRow, readBudget } from "../src/budget";

const directory = mkdtempSync(join(tmpdir(), "frame-budget-"));
const file = join(directory, "budget.json");

afterEach(() => rmSync(file, { force: true }));

function write(value: unknown): void {
  writeFileSync(file, JSON.stringify(value));
}

const valid = {
  observerEffect: [
    {
      metric: "scriptMs",
      threshold: 8,
      instrument: "CDP tracing",
      excludes: "layout",
      lastMeasured: 1.2,
    },
  ],
};

describe("budget files", () => {
  it("resolves a declared row", () => {
    write(valid);
    expect(budgetRow(readBudget(file), "scriptMs")).toMatchObject(valid.observerEffect[0]!);
  });

  it("rejects a row without its instrument or exclusions", () => {
    write({ observerEffect: [{ metric: "scriptMs", threshold: 8, lastMeasured: 1.2 }] });
    expect(() => readBudget(file)).toThrow("instrument and excludes");
  });

  it("rejects an undeclared row", () => {
    write(valid);
    expect(() => budgetRow(readBudget(file), "missing")).toThrow("is not declared");
  });
});
