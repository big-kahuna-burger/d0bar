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
/**
 * When LCP stopped accruing, on the page timeline. `Infinity` until it does.
 *
 * **Deliberately not the same thing as {@link lcpFinal}, and the difference is the point.**
 * `lcpFinal` is d0bar's *moratorium* trigger — the answer to "may we start deriving yet" — and
 * it also fires on the quiet timer, which is a heuristic this file invented. The largest
 * contentful paint stops accruing for two reasons only, both of them in the standard: the user
 * interacted, or the page was hidden. A page that paints something larger 600 ms after load
 * with nobody touching it has a larger LCP, and sealing on the quiet timer would report a
 * smaller number than the browser and every other tool would.
 *
 * A *time* rather than a boolean because observers are registered with `buffered: true`. Mount
 * after an interaction and the first callback delivers every LCP candidate the page ever had;
 * a boolean seal would reject all of them and report no LCP at all on a page that plainly had
 * one. Comparing against the seal's own timestamp keeps the candidates that describe paints
 * from before it.
 */
let lcpSealAt = Infinity;
let cancelSettle: (() => void) | undefined;
let cancelQuietCheck: (() => void) | undefined;
/** When the most recent LCP entry arrived, on the page timeline. */
let lastLcpAt = 0;
let loadedAt = 0;
/** When tracking started, so the ceiling is anchored to something that always happens. */
let startedAt = 0;
let cancelCeiling: (() => void) | undefined;
const settleCallbacks: Array<() => void> = [];
const networkCallbacks: Array<() => void> = [];

export function currentPhase(): Phase {
  return phase;
}

/** Runs `fn` once the load phase has settled, or immediately if it already has. */
export function whenSettled(fn: () => void): void {
  if (phase === "settled") fn();
  else settleCallbacks.push(fn);
}

/**
 * Runs `fn` once the toolbar may issue a request of its own: settled **and** loaded.
 *
 * Settle alone is not enough, and the gap is real rather than theoretical. LCP is final at
 * first input, per the standard, so a user who clicks while the page is still loading lifts
 * the moratorium mid-load — and the two things it gates that reach the network, the stage-2
 * prefetch and worker registration, are justified by "must not compete with the host page's
 * own critical requests". Competing with them is exactly what they would then do.
 *
 * The load half is anchored to the same ceiling as settle, so a page whose `load` never fires
 * still gets its toolbar rather than waiting forever for a signal that is not coming.
 */
export function whenNetworkPermitted(fn: () => void): void {
  if (phase === "settled" && loadedAt !== 0) fn();
  else networkCallbacks.push(fn);
}

function releaseNetwork(): void {
  if (phase !== "settled" || loadedAt === 0) return;
  for (const fn of networkCallbacks) fn();
  networkCallbacks.length = 0;
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
  releaseNetwork();
}

function finalizeLcp(): void {
  if (lcpFinal) return;
  lcpFinal = true;
  cancelSettle = background(settle);
}

/**
 * Called by the observer layer when a `first-input` entry arrives.
 *
 * Two separate consequences, and they are not the same consequence: the moratorium may lift,
 * and LCP stops accruing as of the interaction's own timestamp. `startTime` is passed rather
 * than read from the clock because the entry says when the interaction happened, and the seal
 * has to be that moment rather than the moment we were told about it.
 */
export function noteFirstInput(startTime: number): void {
  sealLcp(startTime);
  finalizeLcp();
}

/** The earliest seal wins: LCP stopped at the first of interaction or hidden, not the last. */
function sealLcp(at: number): void {
  if (at < lcpSealAt) lcpSealAt = at;
}

/**
 * The page-timeline moment LCP stopped accruing, or `Infinity` while it still is.
 *
 * Read by `vitals.ts` for every `largest-contentful-paint` entry. It lives here because the
 * signals that seal it — first input, first hidden — are lifecycle, and lifecycle is this
 * file's job; `vitals.ts` owns the value, not the question of when the page stopped producing
 * candidates for it.
 */
export function lcpSealTime(): number {
  return lcpSealAt;
}

/** Called by the observer layer for every LCP entry, so we can tell when they stop. */
export function noteLcpEntry(): void {
  lastLcpAt = performance.now();
}

function checkQuiet(): void {
  if (lcpFinal) return;
  const now = performance.now();
  const quietFor = now - Math.max(lastLcpAt, loadedAt);
  if (quietFor >= LCP_QUIET_MS || now - startedAt >= MAX_WAIT_MS) {
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
  releaseNetwork();
}

/**
 * The ceiling, anchored to when tracking started rather than to load.
 *
 * `checkQuiet` also carries a ceiling, but it is only ever scheduled *from* `noteLoaded`, so
 * on a page whose `load` event never fires — a hung subresource, a navigation the user
 * abandons — nothing was bounding anything and `observation-core`'s "a page that never stops
 * painting settles at a bounded ceiling" scenario was false for it. This one always runs.
 */
function checkCeiling(): void {
  cancelCeiling = undefined;
  if (loadedAt === 0) loadedAt = performance.now();
  finalizeLcp();
  releaseNetwork();
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
export function noteVisibilityState(name: string, startTime = 0): void {
  const visible = name === "visible";
  documentVisible = visible;
  if (!visible) {
    sealLcp(startTime);
    finalizeLcp();
  }
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
  startedAt = performance.now();
  cancelCeiling = delayed(checkCeiling, MAX_WAIT_MS);
  documentVisible = document.visibilityState !== "hidden";
  if (!supports("visibility-state") && document.visibilityState === "hidden") {
    /* Already hidden when the toolbar mounted, and no entry type to tell us when it happened.
       Sealing at zero is the honest reading: LCP stopped accruing at some point we cannot
       name, and everything after mount is certainly after it. */
    sealLcp(0);
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
    cancelCeiling?.();
  };
}

/** Test seam. */
export function resetPhase(): void {
  phase = "collecting";
  lcpFinal = false;
  lcpSealAt = Infinity;
  lastLcpAt = 0;
  loadedAt = 0;
  startedAt = 0;
  cancelSettle = undefined;
  cancelQuietCheck = undefined;
  cancelCeiling = undefined;
  settleCallbacks.length = 0;
  networkCallbacks.length = 0;
  visibilityCallbacks.length = 0;
  documentVisible = true;
}

/** Test seam: settle synchronously, bypassing the scheduler. */
export function settleNow(): void {
  lcpFinal = true;
  settle();
}
