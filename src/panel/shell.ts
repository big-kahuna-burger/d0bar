import { computed, signal } from "spark-signals/signal";
import type { Tier2State } from "../collector/sw";
import type { OtelState } from "../shared/stage2";

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
 * Tooltip timing.
 *
 * A bubble that appears the instant the pointer touches its trigger is not helpful, it is
 * noise: the footer strip puts four triggers in a row, so crossing it to reach the close
 * button flashes four explanations at someone who asked for none of them. Everything below
 * exists to make hovering *through* free and hovering *at* immediate.
 *
 * - Nothing opens until the pointer has stayed put for {@link TIP_OPEN_MS}. Passing over a
 *   trigger costs nothing at all.
 * - Once one bubble is open the group is warm, and its neighbours open with no delay — four
 *   triggers on one strip read as a single surface, not four independent ones.
 * - Leaving closes after {@link TIP_CLOSE_MS} rather than at once, so the gap between two
 *   adjacent triggers does not blink the bubble off and on again.
 * - The group goes cold {@link TIP_WARM_MS} after the last bubble closes, so returning later
 *   is treated as a fresh intent and waits again.
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

/**
 * Tier 2 (the service worker) is what supplies trace context.
 *
 * The whole state, not a boolean: the footer's tooltip has to say *why* it is off, and the
 * five reasons are not interchangeable — an insecure context, a scope the host owns, and a
 * worker file that 404s send a reader to three different places. A boolean here would have
 * forced the panel to re-derive the reason from somewhere else, or to stop stating it.
 *
 * A signal because it genuinely changes after mount: registration completes asynchronously
 * after settle, and a host worker can claim the scope at any time.
 */
export const tier2 = signal<Tier2State>({ kind: "off", reason: "not-registered" });

export const tier2Live = computed(() => tier2().kind === "live");

/**
 * Tier 4's state.
 *
 * A signal for the same reason `tier2` is one: detection runs at settle and a host can call
 * `otelSpanProcessor()` at any point after that, so a value read once at mount would report
 * `no-sdk` on a page that has since gone live.
 */
export const otel = signal<OtelState>({ kind: "off", reason: "no-sdk" });

/**
 * The toolbar's own measured INP cost, in milliseconds, or `null` when nothing has measured
 * it yet. `add-self-attribution` supplies the value; until then it is null everywhere.
 *
 * Null is not zero. Zero is a claim that the toolbar cost nothing, which is the single
 * most self-serving number this panel could print, and printing it unmeasured would be the
 * toolbar lying about exactly the property it exists to defend.
 */
export const inpDelta = signal<number | null>(null);

export type Perturbation = { text: string; state: "ok" | "degraded" | "unknown" };

/**
 * The footer's right-hand reading, down the honest-degradation ladder.
 *
 * The degraded case outranks the measurement: with tier 2 off there is no trace context, so
 * the panel cannot offer a jump from a request to its trace. Reporting `Δ INP 0.4ms` there
 * would answer a question nobody can act on while staying silent about the capability that
 * is actually missing, so the missing capability is stated instead.
 */
export const perturbation = computed<Perturbation>(() => {
  if (!tier2Live()) return { text: "degraded — no trace jump", state: "degraded" };
  const delta = inpDelta();
  if (delta === null) return { text: "Δ INP unavailable", state: "unknown" };
  return { text: `Δ INP ${delta.toFixed(1)}ms`, state: "ok" };
});

/** The untraced badge is hidden at zero but the tab is retained, per the handoff. */
export const untracedCount = signal(0);
/**
 * The untraced tab's hover copy, written by the view from the same reading the badge and the
 * headline come from.
 *
 * A string rather than the numbers, so there is exactly one place that decides how a coverage
 * reading is worded — including the case where it cannot be worded as a count at all, because
 * tier 2 is off and there is nothing to compare.
 */
export const untracedTooltip = signal("");
export const showUntracedBadge = computed(() => untracedCount() > 0);

/**
 * Pops the trace surface back to the list.
 *
 * Clearing `selected` is the load-bearing half: the trace view's only entry point into the
 * query machine is an effect over `open`, `view` and `selected`, so this is also what aborts
 * whatever that surface had in flight. Leaving the index set would keep a query alive behind
 * a surface nobody is looking at.
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
  if (view() === "trace") {
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
