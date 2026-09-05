import { background } from "./schedule";

/**
 * The stage-2 boundary.
 *
 * Stage 1 is the only thing on a host page's critical path, so the panel is a separate file
 * that is not fetched until someone opens it — or until a background prefetch after settle
 * decides to warm it. `buffered: true` is what makes this free rather than a trade-off: a
 * panel that loads late still receives every entry from page start, so nothing is lost by
 * not being there.
 *
 * **Why a runtime URL rather than `import("../panel")`.** A static dynamic-import specifier
 * makes Rollup emit a chunk, which works for the ES build and silently defeats the IIFE one:
 * IIFE output cannot code-split, so Rollup inlines the chunk back into the single bundle and
 * stage 2 lands on the critical path with no error to notice. Stage 2 is therefore built as
 * its own ES module and loaded by URL, which behaves identically from either build — dynamic
 * `import()` is available in classic scripts, not just modules.
 *
 * The URL is derived from stage 1's own location, so a host serving the bundle from a CDN or
 * a hashed path gets a sibling lookup rather than a guess about their layout.
 */

/** Filename of the stage-2 bundle, a sibling of stage 1. */
const STAGE_2 = "d0bar.panel.js";

/**
 * Stage 1's own URL, captured at module evaluation.
 *
 * `document.currentScript` is a live element only while a classic script is executing, which
 * is exactly the IIFE case; it is `null` during ES module evaluation, where `import.meta.url`
 * is the answer instead. Captured now because both become unavailable later.
 */
const selfUrl = (() => {
  const tag = typeof document !== "undefined" ? document.currentScript : null;
  if (tag instanceof HTMLScriptElement && tag.src) return tag.src;
  try {
    return import.meta.url;
  } catch {
    return undefined;
  }
})();

let override: string | undefined;

/** Test seam, and an escape hatch for a host with an unusual asset layout. */
export function setStage2Url(url: string | undefined): void {
  override = url;
  cached = undefined;
}

function stage2Url(): string | undefined {
  if (override) return override;
  if (!selfUrl) return undefined;
  try {
    return new URL(STAGE_2, selfUrl).href;
  } catch {
    return undefined;
  }
}

/**
 * The in-flight or settled load. Cached so a click during a prefetch joins that fetch rather
 * than starting a second one, and cleared on failure so a retry is possible.
 */
let cached: Promise<PanelModule> | undefined;

/** What stage 2 must export. Kept structural so stage 1 never imports stage 2's types. */
export interface PanelModule {
  openPanel(options: PanelOptions): PanelHandle;
}

export interface PanelOptions {
  /** The closed shadow root the pill already owns. The panel mounts inside it. */
  root: ShadowRoot;
  /** Returns focus to the pill on close. */
  onClose(): void;
}

export interface PanelHandle {
  show(): void;
  close(): void;
  destroy(): void;
}

/**
 * Loads stage 2, reusing an in-flight load. Rejects if the module cannot be fetched; the
 * caller decides whether that is worth showing.
 */
export function loadStage2(): Promise<PanelModule> {
  if (cached) return cached;

  const url = stage2Url();
  if (!url) {
    return Promise.reject(
      new Error("d0bar: could not resolve the panel bundle's URL from stage 1's own location."),
    );
  }

  cached = (import(/* @vite-ignore */ url) as Promise<PanelModule>).catch((error: unknown) => {
    /* Cleared so a later click retries rather than replaying a stale rejection forever. */
    cached = undefined;
    throw error;
  });

  return cached;
}

/**
 * Warms stage 2 at background priority.
 *
 * Called only after the load phase has settled, so the fetch cannot compete with the host's
 * own critical requests. Failure is silent by design — a prefetch is an optimisation, and a
 * console error for one would report a problem the user does not have. The click path
 * surfaces a real failure.
 */
export function prefetchStage2(): () => void {
  return background(() => {
    loadStage2().catch(() => {});
  });
}

/** Test seam. */
export function resetStage2(): void {
  cached = undefined;
  override = undefined;
}
