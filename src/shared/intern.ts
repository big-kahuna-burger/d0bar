/**
 * String interning.
 *
 * Strings are the only allocation source in the load-phase hot path — everything else a
 * resource entry carries is a number. Resource URLs repeat heavily across a page, so
 * mapping them to a `u32` once lets the ring store requests as pure numbers and lets later
 * work (the tier 1 ↔ tier 2 join in particular) key on integers rather than strings.
 */

/** Reserved: the field is empty or the browser did not expose it. */
export const ABSENT = 0;
/** Reserved: the table is full. The value existed but its identity was not retained. */
export const OVERFLOW = 1;

const CAPACITY = 4096;

let table: string[] = ["", "«saturated»"];
let index = new Map<string, number>([
  ["", ABSENT],
  ["«saturated»", OVERFLOW],
]);
let overflows = 0;

/**
 * Returns a stable id for `value`. Ids are dense and start at 2; 0 and 1 are reserved.
 * Past capacity this returns {@link OVERFLOW} rather than growing without bound — a page
 * generating thousands of distinct URLs must not be able to grow the toolbar's memory
 * without limit.
 */
export function intern(value: string): number {
  const hit = index.get(value);
  if (hit !== undefined) return hit;
  if (table.length >= CAPACITY) {
    overflows++;
    return OVERFLOW;
  }
  const id = table.length;
  table.push(value);
  index.set(value, id);
  return id;
}

/** Resolves an id back to its string. Unknown ids resolve to the empty string. */
export function str(id: number): string {
  return table[id] ?? "";
}

export function internStats(): { size: number; capacity: number; overflows: number } {
  return { size: table.length, capacity: CAPACITY, overflows };
}

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetIntern(): void {
  table = ["", "«saturated»"];
  index = new Map([
    ["", ABSENT],
    ["«saturated»", OVERFLOW],
  ]);
  overflows = 0;
}
