import { computed, signal } from "spark-signals/signal";
import type { Tier2State } from "../collector/sw";
import { DISCONNECTED, type TokenStatus } from "../shared/broker";
import type { OtelState } from "../shared/stage2";

/**
 * Shell state: five signals, everything else derived. `plan.md` specified XState; a state chart
 * earns its cost when transitions are hard, and here it is one boolean, one enum and three
 * selections with no illegal intermediates. Nothing here knows what a view renders — views read
 * these signals, the shell never reaches into a view.
 */

export type Tab = "requests" | "vitals" | "untraced";

/** Which surface is showing. `trace` is pushed over the list and popped by Escape. */
export type View = "list" | "trace" | "connect";

export const open = signal(false);
export const tab = signal<Tab>("requests");
export const view = signal<View>("list");

/** Selected record, as a ring index. `-1` is nothing selected. */
export const selected = signal(-1);

/** Which tooltip is showing, by id. Empty string is none — only ever one at a time. */
export const tip = signal("");

/**
 * Tooltip timing: hovering *through* is free, hovering *at* is immediate. The footer puts four
 * triggers in a row, so crossing it to reach close must not flash four explanations.
 *
 *   open   after {@link TIP_OPEN_MS} of the pointer staying put
 *   warm   once one is open, neighbours open with no delay — one surface, not four
 *   close  after {@link TIP_CLOSE_MS}, so the gap between triggers does not blink it off
 *   cold   {@link TIP_WARM_MS} after the last closes, so returning later waits again
 */
const TIP_OPEN_MS = 400;
const TIP_CLOSE_MS = 120;
const TIP_WARM_MS = 400;

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let coldTimer: ReturnType<typeof setTimeout> | undefined;
let warm = false;

function clearTimers(): void {
  if (openTimer !== undefined) clearTimeout(openTimer);
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  openTimer = undefined;
  closeTimer = undefined;
}

/** Pointer or focus arrived on a trigger. */
export function hoverTip(id: string): void {
  clearTimers();
  if (coldTimer !== undefined) {
    clearTimeout(coldTimer);
    coldTimer = undefined;
  }
  if (warm) {
    tip.set(id);
    return;
  }
  openTimer = setTimeout(() => {
    openTimer = undefined;
    warm = true;
    tip.set(id);
  }, TIP_OPEN_MS);
}

/** Pointer or focus left a trigger. */
export function unhoverTip(): void {
  clearTimers();
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    tip.set("");
    coldTimer = setTimeout(() => {
      coldTimer = undefined;
      warm = false;
    }, TIP_WARM_MS);
  }, TIP_CLOSE_MS);
}

/** Closes immediately and goes cold — for Escape, a click, or the panel closing. */
export function dismissTip(): void {
  clearTimers();
  if (coldTimer !== undefined) {
    clearTimeout(coldTimer);
    coldTimer = undefined;
  }
  warm = false;
  tip.set("");
}

/**
 * Per-tab scroll offset, so returning from a trace lands where the user left. Held here, not read
 * back off the DOM: the list is virtualized, so the rows that were on screen no longer exist by
 * teardown.
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

/**
 * Tier 2's whole state, not a boolean: the footer must say *why* it is off, and the five reasons
 * send a reader to different places (insecure context / host-owned scope / a worker file that
 * 404s). A signal because it changes after mount — registration completes post-settle, and a host
 * worker can claim the scope at any time.
 */
export const tier2 = signal<Tier2State>({ kind: "off", reason: "not-registered" });

export const tier2Live = computed(() => tier2().kind === "live");

/**
 * Tier 4's state. A signal for `tier2`'s reason: detection runs at settle and a host can call
 * `otelSpanProcessor()` later, so a mount-time read would report `no-sdk` on a live page.
 */
export const otel = signal<OtelState>({ kind: "off", reason: "no-sdk" });

/**
 * The toolbar's own measured INP cost in ms, or `null` when unmeasured (`add-self-attribution`
 * supplies it). **Null is not zero**: zero claims the toolbar cost nothing — the most self-serving
 * number this panel could print, and unmeasured it would be a lie about the property d0bar exists
 * to defend.
 */
export const inpDelta = signal<number | null>(null);

export type Perturbation = { text: string; state: "ok" | "degraded" | "unknown" };

/**
 * The footer's right-hand reading, down the honest-degradation ladder: the degraded case outranks
 * the measurement. With tier 2 off there is no trace jump, and `Δ INP 0.4ms` would answer a
 * question nobody can act on while staying silent about the missing capability.
 */
export const perturbation = computed<Perturbation>(() => {
  if (!tier2Live()) return { text: "degraded — no trace jump", state: "degraded" };
  const delta = inpDelta();
  if (delta === null) return { text: "Δ INP unavailable", state: "unknown" };
  return { text: `Δ INP ${delta.toFixed(1)}ms`, state: "ok" };
});

/** The untraced badge is hidden at zero but the tab is retained, per the handoff. */
/**
 * Whether a token is connected and where it is kept — the status only, never the token.
 * `TokenStatus` has nowhere to put one, which is what stops this signal leaking a credential into
 * page state.
 */
export const connection = signal<TokenStatus>(DISCONNECTED);

export const untracedCount = signal(0);
/**
 * The untraced tab's hover copy, from the same reading as the badge and headline. A string, not the
 * numbers, so one place decides the wording — including where it cannot be a count at all, because
 * tier 2 is off and there is nothing to compare.
 */
export const untracedTooltip = signal("");
export const showUntracedBadge = computed(() => untracedCount() > 0);

/**
 * Pops the trace surface back to the list. Clearing `selected` is the load-bearing half: the trace
 view's only entry into the query machine is an effect over `open`/`view`/`selected`, so this is
 * also what aborts an in-flight query rather than leaving one alive behind a hidden surface.
 */
export function popToList(): void {
  view.set("list");
  selected.set(-1);
}

/**
 * Escape's meaning depends on depth: from the trace surface it goes back to the list, and
 * from the list it closes. One place, so the keyboard handler has no branching of its own.
 */
export function escape(): void {
  if (tip()) {
    dismissTip();
    return;
  }
  /* Any pushed surface pops before the panel closes. Listing them rather than testing
     `!== "list"` so that adding a surface is a decision about Escape, not a silent inheritance
     of it — a surface with unsaved input may want to confirm rather than discard. */
  if (view() === "trace" || view() === "connect") {
    popToList();
    return;
  }
  open.set(false);
}

export function toggle(): void {
  open.set(!open.peek());
}

export function selectTab(next: Tab): void {
  /* A click is a decision, and the explanation for the thing just chosen is no longer what
     the user is looking at. */
  dismissTip();
  if (tab.peek() === next) return;
  tab.set(next);
  /* A tab change abandons any selection: a record from the requests list has no meaning in
     the vitals tab, and carrying the index across would select an unrelated row. */
  view.set("list");
  selected.set(-1);
}

/** Test seam. */
export function resetShell(): void {
  connection.set(DISCONNECTED);
  open.set(false);
  tab.set("requests");
  view.set("list");
  selected.set(-1);
  dismissTip();
  untracedCount.set(0);
  scrollByTab.clear();
  tier2.set({ kind: "off", reason: "not-registered" });
  inpDelta.set(null);
}
