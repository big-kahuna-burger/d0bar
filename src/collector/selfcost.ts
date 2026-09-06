import { currentPhase } from "./phase";
import { ownScriptUrl } from "../shared/stage2";
import { SELF_MARK, marked } from "../shared/mark";

/**
 * Tier 0 — the toolbar measuring itself.
 *
 * Every other budget in this repo is external: CI loads the fixture twice and subtracts. That
 * proves the property on our machine, to us. This proves it in the customer's browser, to them,
 * out of the same API the panel uses to report their vitals — `long-animation-frame` carries a
 * `scripts[]` breakdown with `sourceURL` and `duration`, so a frame containing d0bar's script can
 * be recognised and charged to d0bar. Self-incrimination from the host's own instrument.
 *
 * The footer printed `Δ INP 0.0ms` before this existed, which was an assumption wearing a
 * measurement's clothes. Zero is only printable once something has looked.
 *
 * **Three attribution modes, and the UI must not present them alike.**
 *
 * ```
 *   url          own script URL known and distinct   ──▶  sourceURL match, or the reserved name
 *   lower-bound  bundled into the host's own chunk   ──▶  only what the reserved name proves
 *   unavailable  no long-animation-frame entry type  ──▶  no figure at all; never zero
 * ```
 *
 * The reserved name counts in *both* measuring modes, not only the floor. Stage 2 is a separate
 * bundle at a different URL, so a URL-only match would silently drop every frame the open panel
 * costs — the largest self cost d0bar has — and report a confident under-count. `shared/mark.ts`
 * puts the name there at no runtime cost, so the union is free.
 *
 * The lower-bound case is real rather than defensive: a host who inlines d0bar into their
 * application bundle gives every script in the frame the same `sourceURL`, and charging the whole
 * frame to d0bar would over-report while charging none would under-report. What is provable is
 * whatever carries a reserved name, and the number is labelled as a floor.
 */

export { SELF_MARK };

export type SelfMode = "url" | "lower-bound" | "unavailable";

export interface SelfCost {
  mode: SelfMode;
  /** Total d0bar-attributed script time inside long animation frames, ms. */
  totalMs: number;
  /** The largest single-frame d0bar total, ms. */
  longestFrameMs: number;
  /** Long animation frames containing any d0bar script. */
  frames: number;
  /**
   * The share accrued before the load phase settled.
   *
   * Zero by construction — the moratorium permits only entry recording until LCP is final — which
   * is exactly why it is measured rather than asserted in a comment. A non-zero reading here is
   * the moratorium having been broken in a build where `assertSettled` was compiled out.
   */
  loadPhaseMs: number;
  /**
   * Frames the reserved name matched, as opposed to the URL.
   *
   * The mechanism's own liveness signal. Marking is the only thing that catches stage 2 (whose
   * URL is not stage 1's) and the only discriminator that exists at all in `lower-bound`, and it
   * is a build-time property that can vanish silently — a terser setting, a refactor that drops a
   * `marked()` call. A URL-matched total would stay confidently non-zero throughout. Counted, so
   * `self-attribution.spec.ts` can assert the browser really reported a `d0bar:` name.
   */
  namedFrames: number;
  /**
   * The heaviest self frames, dominant d0bar callback named. Populated only under `__DEV__`:
   * it is a diagnostic for whoever is making d0bar faster, and retaining strings per frame in a
   * shipped build would be d0bar allocating on the host's main thread to describe itself.
   */
  top: readonly SelfFrame[];
}

export interface SelfFrame {
  ms: number;
  name: string;
}

interface LoafScript {
  sourceURL?: string;
  sourceFunctionName?: string;
  duration?: number;
}

interface LoafEntry extends PerformanceEntry {
  scripts?: LoafScript[];
}

let mode: SelfMode = "unavailable";
let ownUrl = "";
let totalMs = 0;
let longestFrameMs = 0;
let frames = 0;
let loadPhaseMs = 0;
let namedFrames = 0;

/** Shared so a shipped build's `selfCost()` allocates no array for a list it never fills. */
const NO_FRAMES: readonly SelfFrame[] = [];
const TOP_FRAMES = 5;
let top: SelfFrame[] = [];

/**
 * Resolves how this build can recognise itself, once, at init.
 *
 * `supported` is passed rather than read here so the decision lives with the observer layer, which
 * already knows which entry types this browser accepted and is the only place that should ask.
 *
 * Both URLs are injectable for the same reason `otel-sink.ts` injects `timeOrigin`: the interesting
 * case is the one where they are equal, and a test that could only reach it by arranging its own
 * module graph would be testing the runner. Under vitest `import.meta.url` resolves to a real file
 * URL, so without this the bundled case was unreachable.
 */
export function beginSelfCost(
  supported: boolean,
  url: string = ownScriptUrl(),
  documentUrl: string = typeof location !== "undefined" ? location.href : "",
): void {
  if (!supported) {
    mode = "unavailable";
    return;
  }
  /* Indistinguishable from the document means bundled in, or an inline script. Either way the
     `sourceURL` of d0bar's frames is the host's, and URL matching would charge d0bar for the
     host's work in the same frame. */
  if (!url || url === documentUrl) {
    mode = "lower-bound";
    ownUrl = documentUrl;
    return;
  }
  mode = "url";
  ownUrl = url;
}

/**
 * Charges one long animation frame.
 *
 * Called from the same observer callback that feeds `vitals.ts`, so no second observer and no
 * second delivery. The loop allocates nothing: the entry is read and dropped, like everywhere
 * else that touches a browser entry.
 */
export function noteSelfLoaf(entry: PerformanceEntry): void {
  if (mode === "unavailable") return;
  const scripts = (entry as LoafEntry).scripts;
  if (!scripts) return;

  let frameMs = 0;
  let named = false;
  let heaviest = -1;
  let heaviestName = "";
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i] as LoafScript;
    const name = script.sourceFunctionName ?? "";
    const byName = name.startsWith(SELF_MARK);
    if (!byName && !isOurs(script)) continue;
    if (byName) named = true;
    const ms = script.duration ?? 0;
    frameMs += ms;
    if (__DEV__ && ms > heaviest) {
      heaviest = ms;
      heaviestName = name;
    }
  }
  if (frameMs === 0) return;

  frames++;
  if (named) namedFrames++;
  totalMs += frameMs;
  if (frameMs > longestFrameMs) longestFrameMs = frameMs;
  /* The frame is charged to the phase it started in. A frame straddling settle is load-phase work
     that ran late rather than post-settle work that started early, and rounding it the other way
     would let a moratorium violation hide behind its own duration. */
  if (currentPhase() === "collecting") loadPhaseMs += frameMs;
  if (__DEV__) noteTop(frameMs, heaviestName);
}

/** Insertion sort into a five-slot list. Dev only; see `SelfCost.top`. */
function noteTop(ms: number, name: string): void {
  if (top.length === TOP_FRAMES && ms <= (top[TOP_FRAMES - 1] as SelfFrame).ms) return;
  top.push({ ms, name });
  top.sort((a, b) => b.ms - a.ms);
  if (top.length > TOP_FRAMES) top.length = TOP_FRAMES;
}

/** URL match only; the caller has already tried the name, which counts in every mode. */
function isOurs(script: LoafScript): boolean {
  return mode === "url" && (script.sourceURL ?? "") === ownUrl;
}

export function selfCost(): SelfCost {
  return {
    mode,
    totalMs,
    longestFrameMs,
    frames,
    namedFrames,
    loadPhaseMs,
    top: __DEV__ ? top : NO_FRAMES,
  };
}

/**
 * Names a callback so a long animation frame containing it is attributable to d0bar.
 *
 * Re-exported here rather than imported from `shared/mark.ts` at each callsite so the mechanism
 * and the thing that reads it stay one module apart, not two.
 */
export { marked };

/** Test seam. */
export function resetSelfCost(): void {
  mode = "unavailable";
  ownUrl = "";
  totalMs = 0;
  longestFrameMs = 0;
  frames = 0;
  namedFrames = 0;
  loadPhaseMs = 0;
  top = [];
}
