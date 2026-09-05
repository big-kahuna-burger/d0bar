import { beginPhaseTracking, currentPhase, whenSettled } from "./phase";
import { activeEntryTypes, startObserving } from "./observe";
import { definePill, mountPill } from "./pill";
import { scheduleMode } from "../shared/schedule";
import { internStats } from "../shared/intern";
import { size, stats } from "./ring";
import { loadStage2, prefetchStage2, type PanelHandle } from "../shared/stage2";

/**
 * Stage 1 — the only part of the toolbar on a host page's critical path.
 *
 * Everything here is either the opt-in gate, an observer registration, or a write into a
 * preallocated buffer. The panel arrives as a separate stage, imported on demand, so a page
 * whose developer never opens the toolbar pays for none of it.
 */

export interface D0barConfig {
  /**
   * Required. The package is inert without it — no observation, no DOM, no network, no
   * storage. A toolbar that activates itself inside someone's production app by being
   * present in the bundle is not acceptable.
   */
  enabled: boolean;
}

export interface D0barHandle {
  readonly enabled: boolean;
  /** Removes every observer, listener, node and timer the toolbar created. */
  destroy(): void;
  /** What the toolbar is actually made of on this browser. */
  diagnostics(): Diagnostics;
}

export interface Diagnostics {
  phase: "collecting" | "settled";
  entryTypes: readonly string[];
  requests: number;
  dropped: number;
  interned: number;
  internOverflows: number;
  scheduling: string;
}

const inert: D0barHandle = {
  enabled: false,
  destroy() {},
  diagnostics() {
    return {
      phase: "collecting",
      entryTypes: [],
      requests: 0,
      dropped: 0,
      interned: 0,
      internOverflows: 0,
      scheduling: "none",
    };
  },
};

let live: D0barHandle | undefined;

/**
 * Starts the toolbar. Calling this without `enabled: true` returns an inert handle and does
 * nothing at all — that path is asserted in CI, not merely intended.
 */
export function init(config: D0barConfig): D0barHandle {
  if (!config || config.enabled !== true) return inert;
  if (live) return live;

  const stopPhase = beginPhaseTracking();
  const stopObserving = startObserving();
  definePill();

  let panel: PanelHandle | undefined;
  let panelOpen = false;
  let opening = false;

  const pill = mountPill(() => {
    /* The pill toggles. Once stage 2 is loaded the panel persists and its `open` signal is
       flipped, so reopening costs no fetch and no rebuild — and the shell keeps the tab and
       scroll position the user left it on. */
    if (panel) {
      panelOpen = !panelOpen;
      if (panelOpen) panel.show();
      else panel.close();
      return;
    }
    if (opening) return;
    const root = pill.root();
    if (!root) return;

    opening = true;
    loadStage2()
      .then((module) => {
        /* `destroy()` may have run while stage 2 was in flight. */
        const current = pill.root();
        if (!current) return;
        panel = module.openPanel({
          root: current,
          onClose() {
            panelOpen = false;
            pill.focus();
          },
        });
        panelOpen = true;
      })
      .catch((error: unknown) => {
        /* The panel could not be fetched or failed to mount — offline, a blocked path, a
           host CSP that forbids it. The pill keeps working as ambient status, which is the
           whole of what it promised before stage 2 existed; it must never throw into the
           host page. Reported in development only, because a customer's console is not
           ours to write to. */
        if (__DEV__) console.error("d0bar: opening the panel failed.", error);
      })
      .finally(() => {
        opening = false;
      });
  });

  /* Warmed only after the load phase settles, at background priority, so the fetch cannot
     compete with the host page's own critical requests. A click during the prefetch joins
     that same load rather than starting a second one. */
  let cancelPrefetch: (() => void) | undefined;
  whenSettled(() => {
    cancelPrefetch = prefetchStage2();
  });

  live = {
    enabled: true,
    destroy() {
      cancelPrefetch?.();
      panel?.destroy();
      panel = undefined;
      pill.destroy();
      stopObserving();
      stopPhase();
      live = undefined;
    },
    diagnostics() {
      const ring = stats();
      const interned = internStats();
      return {
        phase: currentPhase(),
        entryTypes: activeEntryTypes(),
        requests: size(),
        dropped: ring.dropped,
        interned: interned.size,
        internOverflows: interned.overflows,
        scheduling: scheduleMode(),
      };
    },
  };
  return live;
}

/** Tears down a running toolbar. Safe to call when nothing is running. */
export function destroy(): void {
  live?.destroy();
}
