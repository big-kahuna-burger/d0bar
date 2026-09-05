import { computed, signal } from "spark-signals/signal";

/**
 * Shell state.
 *
 * Five signals, and everything else derived. `plan.md` specified XState for this; a state
 * chart earns its cost when transitions are the hard part, and here they are not — the shell
 * has one boolean, one enum and three selections, with no illegal intermediate states to
 * guard. XState is retained for the trace and auth flows, which do have them.
 *
 * Nothing here knows what a view renders. Views read these signals; the shell never reaches
 * into a view.
 */

export type Tab = "requests" | "vitals" | "untraced";

/** Which surface is showing. `trace` is pushed over the list and popped by Escape. */
export type View = "list" | "trace";

export const open = signal(false);
export const tab = signal<Tab>("requests");
export const view = signal<View>("list");

/** Selected record, as a ring index. `-1` is nothing selected. */
export const selected = signal(-1);

/** Which tooltip is showing, by id. Empty string is none — only ever one at a time. */
export const tip = signal("");

/**
 * Scroll offset per tab, so returning from a trace lands where the user left.
 *
 * Held here rather than read back off the DOM: the list is virtualized, so by the time the
 * trace view has been torn down the rows that were on screen no longer exist to measure.
 */
const scrollByTab = new Map<Tab, number>();

export function rememberScroll(which: Tab, offset: number): void {
  scrollByTab.set(which, offset);
}

export function recallScroll(which: Tab): number {
  return scrollByTab.get(which) ?? 0;
}

/** True when the trace surface is showing, so Escape pops rather than closes. */
export const inTrace = computed(() => view() === "trace");

/** The untraced badge is hidden at zero but the tab is retained, per the handoff. */
export const untracedCount = signal(0);
export const showUntracedBadge = computed(() => untracedCount() > 0);

/**
 * Escape's meaning depends on depth: from the trace surface it goes back to the list, and
 * from the list it closes. One place, so the keyboard handler has no branching of its own.
 */
export function escape(): void {
  if (tip()) {
    tip.set("");
    return;
  }
  if (view() === "trace") {
    view.set("list");
    selected.set(-1);
    return;
  }
  open.set(false);
}

export function toggle(): void {
  open.set(!open.peek());
}

export function selectTab(next: Tab): void {
  if (tab.peek() === next) return;
  tab.set(next);
  /* A tab change abandons any selection: a record from the requests list has no meaning in
     the vitals tab, and carrying the index across would select an unrelated row. */
  view.set("list");
  selected.set(-1);
}

/** Test seam. */
export function resetShell(): void {
  open.set(false);
  tab.set("requests");
  view.set("list");
  selected.set(-1);
  tip.set("");
  untracedCount.set(0);
  scrollByTab.clear();
}
