import { background, delayed } from "../shared/schedule";

/**
 * The load-phase moratorium: until the host's LCP is final, the only permitted work is recording
 * an entry. No derivation, no DOM write, no worker message, no network. Free because `buffered:
 * true` re-delivers every entry from page start, so deferring loses nothing.
 *
 * LCP is final, per the standard, at the first of first-input or document-hidden — and at neither
 * on a page nobody touches. **Load is not an LCP finalizer**: a JS-rendered largest element
 * reports LCP long after load, so settling there would lift the moratorium while the metric it
 * protects is still accruing. Instead: after load, wait for LCP quiet ({@link LCP_QUIET_MS}), then
 * settle one background task later so the settle never lands inside the load burst. A ceiling
 * covers a page that paints forever.
 *
 * Registers **no host listener**. Load arrives as a `navigation` entry with non-zero
 * `loadEventEnd`, visibility as `visibility-state`, first input as `first-input`. (The toolbar's
 * single listener is the keyboard shortcut, in `shortcut.ts`.) Missing types:
 * {@link beginPhaseTracking}.
 */

/** No new LCP entry for this long, after load, means the browser has stopped raising it. */
const LCP_QUIET_MS = 500;
/** Ceiling, so a page that paints forever still settles. */
const MAX_WAIT_MS = 10_000;

export type Phase = "collecting" | "settled";

let phase: Phase = "collecting";
let lcpFinal = false;
/**
 * When LCP stopped accruing, page timeline; `Infinity` until it does.
 *
 * **Not {@link lcpFinal}, and the gap is the point.** `lcpFinal` also fires on the quiet timer, a
 * heuristic this file invented. LCP stops accruing for two standard reasons only — interaction or
 * hidden — so sealing on the quiet timer would under-report a page that paints something larger
 * 600 ms after load.
 *
 * A *time*, not a boolean, because of `buffered: true`: mount after an interaction and the first
 * callback delivers every candidate the page ever had, which a boolean seal would reject wholesale
 * and report no LCP at all. Comparing timestamps keeps the paints from before the seal.
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
 * Runs `fn` once the toolbar may issue its own request: settled **and** loaded.
 *
 * Settle alone is not enough. LCP is final at first input, so a user clicking mid-load lifts the
 * moratorium mid-load — and the two things it gates that reach the network (stage-2 prefetch,
 * worker registration) are justified by not competing with the host's critical requests, which is
 * exactly what they would then do. The load half shares settle's ceiling, so a page whose `load`
 * never fires still gets a toolbar.
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
 * Dev guard, called first by anything that derives, writes DOM, posts to a worker or fetches — so
 * a moratorium violation fails loudly here rather than silently costing a customer main-thread
 * time in production.
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
 * A `first-input` entry. Two distinct consequences: the moratorium may lift, and LCP seals at the
 * interaction's own `startTime` — passed rather than read from the clock, because the seal must be
 * when it happened, not when we were told.
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
 * When LCP stopped accruing, or `Infinity`. Read by `vitals.ts` per candidate. Lives here because
 * the sealing signals are lifecycle; `vitals.ts` owns the value, not the question of when the page
 * stopped producing candidates.
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
 * A `navigation` entry with non-zero `loadEventEnd`. The entry is delivered twice — first with
 * every field zero, then again after the load event — and only the second means anything; the
 * guard is at the call site in `observe.ts`.
 */
export function noteLoaded(): void {
  if (loadedAt !== 0) return;
  loadedAt = performance.now();
  cancelQuietCheck = delayed(checkQuiet, LCP_QUIET_MS);
  releaseNetwork();
}

/**
 * The ceiling, anchored to tracking start rather than load. `checkQuiet` carries one too, but is
 * only scheduled *from* `noteLoaded` — so on a page whose `load` never fires (hung subresource,
 * abandoned navigation) nothing bounded anything and `observation-core`'s bounded-ceiling scenario
 * was false. This one always runs.
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
 * Visibility changes, from `visibility-state` entries rather than a host listener. Returns an
 * unsubscribe. Without the entry type no callback ever fires, so a subscriber must stay correct
 * when never told the page hid: this may gate work (which the browser throttles anyway), never
 * correctness.
 */
export function onVisibility(fn: (visible: boolean) => void): () => void {
  visibilityCallbacks.push(fn);
  return () => {
    const at = visibilityCallbacks.indexOf(fn);
    if (at !== -1) visibilityCallbacks.splice(at, 1);
  };
}

/**
 * Last reported visibility, for a caller needing current state rather than the next change — the
 * panel's list decides whether to paint before seeing a transition. Defaults visible, and stays
 * true forever without the entry type: gate work with it, never correctness.
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
 * Fallback without the `navigation` entry type. A poll, not a `load` listener — a host listener is
 * the one thing this module exists to avoid. Runs at the quiet interval, only pre-load, only where
 * needed, and `checkQuiet`'s ceiling stops it running forever.
 */
function pollReadyState(): void {
  if (document.readyState === "complete") {
    noteLoaded();
    return;
  }
  cancelQuietCheck = delayed(pollReadyState, LCP_QUIET_MS);
}

/**
 * Starts tracking; returns a teardown. No host listener: load, visibility and first input arrive as
 * entries via `observe.ts`. Missing types degrade rather than reach for a listener — no
 * `navigation` polls `readyState`, no `visibility-state` reads `document.visibilityState` once and
 * cannot see a later change, costing a finalizer on a backgrounded page and bounded by the ceiling.
 */
export function beginPhaseTracking(): () => void {
  /* Read once, not observed: seeing a later change without the entry type costs a host listener. */
  startedAt = performance.now();
  cancelCeiling = delayed(checkCeiling, MAX_WAIT_MS);
  documentVisible = document.visibilityState !== "hidden";
  if (!supports("visibility-state") && document.visibilityState === "hidden") {
    /* Hidden at mount, no entry type to say when. Seal at zero: LCP stopped at a moment we
       cannot name, and everything after mount is certainly after it. */
    sealLcp(0);
    finalizeLcp();
  }

  if (supports("navigation")) {
    /* `observe.ts` calls `noteLoaded` on the completed entry, buffered ones included. */
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
