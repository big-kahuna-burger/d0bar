import { background, delayed } from "../shared/schedule";

/**
 * The load-phase moratorium.
 *
 * The highest-leverage rule in the toolbar, and it costs nothing: until the host page's LCP
 * is final, the only work permitted is recording an entry. No derivation, no DOM write, no
 * worker message, no network request.
 *
 * `buffered: true` is what makes this free — deferring loses no data, because observers
 * registered at any point still receive every entry from page start. So the toolbar
 * contributes nothing to LCP or TBT as a structural property rather than as a hope.
 *
 * LCP is final, per the standard, at the first of first input or the document becoming
 * hidden — and at neither of those on a page nobody touches. The load event is NOT an LCP
 * finalizer: an application that renders its largest element from JavaScript reports LCP
 * long after load, and settling at load would end the moratorium while the very metric it
 * protects is still being recorded.
 *
 * So after load the toolbar waits for LCP to go quiet — no new entry for {@link LCP_QUIET_MS}
 * — and settles then, with a hard ceiling so a page that never stops painting still gets a
 * toolbar. One background task must run after that, so the settle never lands inside the
 * load burst.
 *
 * Every signal this module needs arrives as a performance entry, so it registers no listener
 * on the host page at all. (The toolbar has exactly one, for the keyboard shortcut, and it is
 * not here — see `shortcut.ts`.) Load comes from the `navigation` entry once its `loadEventEnd` is
 * non-zero, visibility from the `visibility-state` entry type, and first input from
 * `first-input`. See {@link beginPhaseTracking} for what happens where those are missing.
 */

/** No new LCP entry for this long, after load, means the browser has stopped raising it. */
const LCP_QUIET_MS = 500;
/** Ceiling, so a page that paints forever still settles. */
const MAX_WAIT_MS = 10_000;

export type Phase = "collecting" | "settled";

let phase: Phase = "collecting";
let lcpFinal = false;
let cancelSettle: (() => void) | undefined;
let cancelQuietCheck: (() => void) | undefined;
/** When the most recent LCP entry arrived, on the page timeline. */
let lastLcpAt = 0;
let loadedAt = 0;
const settleCallbacks: Array<() => void> = [];

export function currentPhase(): Phase {
  return phase;
}

/** Runs `fn` once the load phase has settled, or immediately if it already has. */
export function whenSettled(fn: () => void): void {
  if (phase === "settled") fn();
  else settleCallbacks.push(fn);
}

/**
 * Development guard. Any code that derives, touches the DOM, posts to a worker, or fetches
 * calls this first, so a violation of the moratorium fails loudly in development instead of
 * silently costing a customer main-thread time in production.
 */
export function assertSettled(operation: string): void {
  if (__DEV__ && phase === "collecting") {
    throw new Error(
      `d0bar: ${operation} attempted during the load phase. Only entry recording is permitted before settle.`,
    );
  }
}

function settle(): void {
  if (phase === "settled") return;
  phase = "settled";
  for (const fn of settleCallbacks) fn();
  settleCallbacks.length = 0;
}

function finalizeLcp(): void {
  if (lcpFinal) return;
  lcpFinal = true;
  cancelSettle = background(settle);
}

/** Called by the observer layer when a `first-input` entry arrives. LCP is final now. */
export function noteFirstInput(): void {
  finalizeLcp();
}

/** Called by the observer layer for every LCP entry, so we can tell when they stop. */
export function noteLcpEntry(): void {
  lastLcpAt = performance.now();
}

function checkQuiet(): void {
  if (lcpFinal) return;
  const now = performance.now();
  const quietFor = now - Math.max(lastLcpAt, loadedAt);
  if (quietFor >= LCP_QUIET_MS || now - loadedAt >= MAX_WAIT_MS) {
    finalizeLcp();
    return;
  }
  cancelQuietCheck = delayed(checkQuiet, LCP_QUIET_MS - quietFor);
}

/**
 * Called by the observer layer for a `navigation` entry whose `loadEventEnd` is non-zero.
 *
 * The entry is delivered twice: once early with every field still zero, then again once the
 * load event has run. Only the second delivery means anything here, and the guard for that
 * lives at the call site in `observe.ts`.
 */
export function noteLoaded(): void {
  if (loadedAt !== 0) return;
  loadedAt = performance.now();
  cancelQuietCheck = delayed(checkQuiet, LCP_QUIET_MS);
}

const visibilityCallbacks: Array<(visible: boolean) => void> = [];
let documentVisible = true;

/**
 * Subscribes to visibility changes, which arrive as `visibility-state` entries rather than
 * from a listener on the host document. Returns an unsubscribe function.
 *
 * Where the entry type is unsupported no callback ever fires, so a subscriber must be correct
 * when it is never told the page was hidden — the cost is work that keeps running in a
 * background tab, which the browser throttles anyway. It must never be correctness.
 */
export function onVisibility(fn: (visible: boolean) => void): () => void {
  visibilityCallbacks.push(fn);
  return () => {
    const at = visibilityCallbacks.indexOf(fn);
    if (at !== -1) visibilityCallbacks.splice(at, 1);
  };
}

/**
 * The last visibility reported, for a caller that needs the current state rather than the
 * next change — the panel's list, which must decide whether to paint at all before it has
 * seen a transition.
 *
 * Defaults to visible, and the same caveat as {@link onVisibility} applies: where the entry
 * type is unsupported this stays true forever, so it may only gate work, never correctness.
 */
export function isVisible(): boolean {
  return documentVisible;
}

/** Called by the observer layer for every `visibility-state` entry. */
export function noteVisibilityState(name: string): void {
  const visible = name === "visible";
  documentVisible = visible;
  if (!visible) finalizeLcp();
  for (let i = 0; i < visibilityCallbacks.length; i++) visibilityCallbacks[i]!(visible);
}

function supports(type: string): boolean {
  const types = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(types) && types.indexOf(type) !== -1;
}

/**
 * Polling fallback for browsers without the `navigation` entry type. Chosen over a `load`
 * listener deliberately: a listener on the host is the one thing this module exists to avoid,
 * and the poll runs at the quiet interval, only before load, and only on browsers that need
 * it. `checkQuiet` supplies the ceiling once it starts, so this cannot run forever.
 */
function pollReadyState(): void {
  if (document.readyState === "complete") {
    noteLoaded();
    return;
  }
  cancelQuietCheck = delayed(pollReadyState, LCP_QUIET_MS);
}

/**
 * Starts tracking. Returns a teardown cancelling any scheduled work.
 *
 * No listener is registered on the host page. Load, visibility and first input all arrive as
 * performance entries, routed here by `observe.ts`. Where an entry type is missing the
 * toolbar degrades rather than reaching for a listener: without `navigation` it polls
 * `document.readyState`, and without `visibility-state` it reads `document.visibilityState`
 * once and then cannot observe a later change — which costs a finalizer on a page the user
 * backgrounds, and is bounded by the ceiling in {@link checkQuiet}.
 */
export function beginPhaseTracking(): () => void {
  /* Read once, not observed: without the entry type there is no way to see a later change
     that does not cost the host a listener, so the toolbar takes the state it can have and
     `isVisible()` documents that it may go stale. */
  documentVisible = document.visibilityState !== "hidden";
  if (!supports("visibility-state") && document.visibilityState === "hidden") {
    finalizeLcp();
  }

  if (supports("navigation")) {
    /* `observe.ts` calls `noteLoaded` when the completed entry arrives, including from the
       buffer when the toolbar mounts after load. */
  } else if (document.readyState === "complete") {
    noteLoaded();
  } else {
    pollReadyState();
  }

  return () => {
    cancelSettle?.();
    cancelQuietCheck?.();
  };
}

/** Test seam. */
export function resetPhase(): void {
  phase = "collecting";
  lcpFinal = false;
  lastLcpAt = 0;
  loadedAt = 0;
  cancelSettle = undefined;
  cancelQuietCheck = undefined;
  settleCallbacks.length = 0;
  visibilityCallbacks.length = 0;
  documentVisible = true;
}

/** Test seam: settle synchronously, bypassing the scheduler. */
export function settleNow(): void {
  lcpFinal = true;
  settle();
}
