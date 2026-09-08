import { readFileSync } from "node:fs";

/** A gate declared in the committed budget file. */
export interface BudgetRow {
  /** Stable identifier claimed by a measurement. */
  metric: string;
  /** Numeric ceiling. A null value is reported but deliberately not enforced. */
  threshold: number | null;
  /** The mechanism that produced the measurement. */
  instrument: string;
  /** What the instrument cannot observe. */
  excludes: string;
  /** The last committed observation, retained for calibration context. */
  lastMeasured: unknown;
  [key: string]: unknown;
}

export interface BudgetFile {
  rows: ReadonlyMap<string, BudgetRow>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(value: unknown, rows: Map<string, BudgetRow>): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, rows);
    return;
  }
  if (!isRecord(value)) return;

  if (typeof value.metric === "string") {
    const metric = value.metric;
    const row = value as Partial<BudgetRow>;
    if (typeof row.instrument !== "string" || typeof row.excludes !== "string") {
      throw new Error(
        `budget row ${JSON.stringify(metric)} must declare instrument and excludes`,
      );
    }
    if (typeof row.threshold !== "number" && row.threshold !== null) {
      throw new Error(
        `budget row ${JSON.stringify(metric)} must declare a numeric or null threshold`,
      );
    }
    if (!("lastMeasured" in row)) {
      throw new Error(`budget row ${JSON.stringify(metric)} must declare lastMeasured`);
    }
    if (rows.has(metric))
      throw new Error(`budget row ${JSON.stringify(metric)} is declared twice`);
    rows.set(metric, row as BudgetRow);
  }

  for (const child of Object.values(value)) collect(child, rows);
}

/** Reads and validates a budget document without making any measurement. */
export function readBudget(file: string): BudgetFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read budget file ${file}`, { cause: error });
  }
  const rows = new Map<string, BudgetRow>();
  collect(parsed, rows);
  return { rows };
}

/** Resolves one declared row; an undeclared measurement is always a test error. */
export function budgetRow(budget: BudgetFile, metric: string): BudgetRow {
  const row = budget.rows.get(metric);
  if (!row) throw new Error(`budget row ${JSON.stringify(metric)} is not declared`);
  return row;
}
