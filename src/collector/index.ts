import {
  beginPhaseTracking,
  currentPhase,
  isVisible,
  assertSettled,
  onVisibility,
  resetPhase,
  whenNetworkPermitted,
} from "./phase";
import { activeEntryTypes, onResourceBatch, onVitalsBatch, startObserving } from "./observe";
import { definePill, mountPill } from "./pill";
import { scheduleMode } from "../shared/schedule";
import { internStats, resetIntern } from "../shared/intern";
import {
  adoptSpan,
  correlate,
  flagConflict,
  read,
  resetRing,
  scratch,
  size,
  stats,
} from "./ring";
import { readSpan, resetSpanSink, spanCount, spanScratch } from "./otel-sink";
import { resetCorrelation } from "./correlate";
import { resetSelfCost, selfCost } from "./selfcost";
import { loadStage2, prefetchStage2, type PanelHandle } from "../shared/stage2";
import { installShortcut } from "./shortcut";
import { readPanelRestore, type RestoredPictureInPictureWindow } from "../shared/panel-restore";
import { resetVitals, snapshot as vitalsSnapshot } from "./vitals";
import { resetTier2, startTier2, tier2State, type SwConfig, type Tier2State } from "./sw";
import { detectOtel, otelState, resetOtel, type OtelState } from "./otel";
import type { SelfCost } from "./selfcost";
import { epochSource, resetEpoch, selectTier, type EpochSource } from "./epoch";

/**
 * Stage 1 — the only part of the toolbar on the host's critical path. Everything here is the opt-in
 * gate, an observer registration, or a write into a preallocated buffer; the panel is a separate
 * stage imported on demand, so a developer who never opens it pays for none of it.
 */

export interface D0barConfig {
  /**
   * Required. The package is inert without it — no observation, no DOM, no network, no
   * storage. A toolbar that activates itself inside someone's production app by being
   * present in the bundle is not acceptable.
   */
  enabled: boolean;
  /**
   * The chord that toggles the panel, or `false` to register no keyboard listener at all.
   * Defaults to `"Mod+Shift+0"` — `Mod` being command on Apple platforms and control
   * elsewhere. See `shortcut.ts` for why this is the toolbar's only host listener.
   */
  shortcut?: string | false | undefined;
  /**
   * Where the host serves d0bar's service worker. Tier 2 — the only source of a `traceparent`, since
   * `PerformanceResourceTiming` exposes no request headers — stays off until this is set. Opt-in,
   * not a guessed default: registering a worker is a persistent origin-scoped side effect on someone
   * else's site, and an invented path 404s against their routing. Omitting it gets tier 1, and the
   * panel says so.
   */
  sw?: SwConfig | undefined;
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
  /** Which browser capability supplies route epochs. */
  epochSource: EpochSource;
  /** Whether tier 2 is live, and if not, why not. */
  tier2: Tier2State;
  /** Whether tier 4 is live, who owns the attachment, and if it is off, why. */
  otel: OtelState;
  /** What d0bar's own script cost this page, and by which attribution method. */
  self: SelfCost;
  requests: number;
  dropped: number;
  interned: number;
  internOverflows: number;
  scheduling: string;
  /** Whether this browser exposes Document Picture-in-Picture for panel detachment. */
  panelDetach: boolean;
}

const inert: D0barHandle = {
  enabled: false,
  destroy() {},
  diagnostics() {
    return {
      phase: "collecting",
      entryTypes: [],
      epochSource: "document",
      tier2: { kind: "off", reason: "not-registered" },
      otel: { kind: "off", reason: "no-sdk" },
      self: {
        mode: "unavailable",
        totalMs: 0,
        longestFrameMs: 0,
        frames: 0,
        namedFrames: 0,
        loadPhaseMs: 0,
        top: [],
      },
      requests: 0,
      dropped: 0,
      interned: 0,
      internOverflows: 0,
      scheduling: "none",
      panelDetach: "documentPictureInPicture" in globalThis,
    };
  },
};

let live: D0barHandle | undefined;
let liveConfig: D0barConfig | undefined;
/* Once per page. A host reinitialising in a loop must not turn a diagnostic into a flood. */
let warnedAboutReinit = false;

/**
 * Whether a second `init()` asked for something the running toolbar is not doing. Only the fields
 * that change behaviour, compared as `init()` reads them: `shortcut` through its default, `sw` field
 * by field — a fresh literal with identical contents is the ordinary case and not a difference. At
 * most once per page, off the critical path.
 */
function differs(next: D0barConfig, prev: D0barConfig | undefined): boolean {
  if (!prev) return false;
  if ((next.shortcut ?? "Mod+Shift+0") !== (prev.shortcut ?? "Mod+Shift+0")) return true;
  const a = (next.sw ?? {}) as Record<string, unknown>;
  const b = (prev.sw ?? {}) as Record<string, unknown>;
  for (const key in a) if (a[key] !== b[key]) return true;
  for (const key in b) if (a[key] !== b[key]) return true;
  return false;
}

/**
 * Starts the toolbar. Calling this without `enabled: true` returns an inert handle and does
 * nothing at all — that path is asserted in CI, not merely intended.
 */
export function init(config: D0barConfig): D0barHandle {
  if (!config || config.enabled !== true) return inert;
  if (live) {
    /* A second `init()` cannot apply the new configuration — the shortcut is registered, the
       worker path is captured, and re-registering observers would double-count. Returning the
       running handle is therefore right; returning it *silently* was not. A host that changed
       `sw` or `shortcut` and saw nothing happen had no way to learn why. */
    if (differs(config, liveConfig)) {
      const message =
        "d0bar: init() was called again with a different configuration while the toolbar was " +
        "already running. The running configuration is kept; call destroy() first to change it.";
      if (__DEV__) throw new Error(message);
      if (!warnedAboutReinit) {
        warnedAboutReinit = true;
        console.warn(message);
      }
    }
    return live;
  }
  liveConfig = config;

  selectTier();

  const stopPhase = beginPhaseTracking();
  const stopObserving = startObserving();
  definePill();

  let pendingRestore = readPanelRestore(location.pathname + location.search);

  let panel: PanelHandle | undefined;
  let panelOpen = false;
  let opening = false;

  function toggle(): void {
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
    pill.setPending(true);
    const restore = pendingRestore;
    pendingRestore = undefined;
    pill.setRestorePending(false);
    /* `requestWindow()` is invoked directly from the pill click. The browser therefore sees a
       user activation even if the stage-2 import resolves later. */
    const restoreWindow: Promise<RestoredPictureInPictureWindow | undefined> = restore
      ? (() => {
          const api = (
            globalThis as typeof globalThis & {
              documentPictureInPicture?: {
                requestWindow(options: {
                  width: number;
                  height: number;
                }): Promise<RestoredPictureInPictureWindow>;
              };
            }
          ).documentPictureInPicture;
          if (!api) return Promise.resolve(undefined);
          return api
            .requestWindow({ width: restore.width, height: restore.height })
            .catch(() => undefined);
        })()
      : Promise.resolve(undefined);
    Promise.all([loadStage2(), restoreWindow])
      .then(([module, restoredWindow]) => {
        /* `destroy()` may have run while stage 2 was in flight. */
        const current = pill.root();
        if (!current) return;
        panel = module.openPanel({
          root: current,
          /* Read at open time, not at init: registration completes asynchronously after
             settle, so a value captured earlier would be `not-registered` forever. */
          tier2: tier2State(),
          /* Read at open time for the same reason as tier 2: detection runs at settle, which
             may not have happened when a host called `init()`. */
          otel: otelState(),
          /* The ring stays here, in stage 1, and the panel is given a window onto it. */
          tier1: {
            entries() {
              const out = scratch();
              const list: Array<{ index: number; url: string; startTime: number }> = [];
              for (let i = 0; i < size(); i += 1) {
                if (!read(i, out)) continue;
                list.push({ index: i, url: out.url, startTime: out.startTime });
              }
              return list;
            },
            correlate,
            adoptSpan: (index, contextId) => {
              adoptSpan(index, contextId);
            },
            flagConflict: (index) => {
              flagConflict(index);
            },
            spans() {
              /* Projected, not handed over: the sink's storage is typed arrays in stage 1,
                 and the join needs five strings per span. An empty array is the ordinary
                 case — most pages have no OpenTelemetry SDK at all. */
              const out = spanScratch();
              const list: Array<{
                url: string;
                order: number;
                traceId: string;
                spanId: string;
              }> = [];
              for (let i = 0; i < spanCount(); i += 1) {
                if (!readSpan(i, out)) continue;
                list.push({
                  url: out.url,
                  /* Issue order within the flush. The sink is append-only, so its index is
                     end order — which is the closest thing to issue order available, and the
                     same approximation tier 2's `order` makes. */
                  order: i,
                  traceId: out.traceId,
                  spanId: out.spanId,
                });
              }
              return list;
            },
            stats,
            /* `read` returns the scratch it filled, or undefined; the boundary wants a
               boolean so neither side has to agree on identity across the two bundles. */
            read: (index, out) => read(index, out) !== undefined,
            onBatch: onResourceBatch,
            onVisibility,
            visible: isVisible,
            /* Composed here rather than inside `snapshot()`: which entry types this browser
               accepted is `observe.ts`'s knowledge, and the vitals module has no business
               knowing whether its own observers were ever registered. */
            vitals() {
              const reading = vitalsSnapshot();
              reading.entryTypes = activeEntryTypes();
              reading.self = selfCost();
              return reading;
            },
            onVitals: onVitalsBatch,
          },
          restore,
          restoreWindow: restoredWindow,
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
        pill.setPending(false);
      });
  }

  const pill = mountPill(toggle);
  pill.setRestorePending(pendingRestore !== undefined);

  /* The toolbar's only listener on the host page. Registered here in stage 1, so the chord
     opens the panel before stage 2 has ever been fetched — which is the whole reason it
     cannot live in the panel's own keydown handler. */
  const stopShortcut = installShortcut({ shortcut: config.shortcut, onToggle: toggle });

  /* Settled *and* loaded, at background priority, so the fetch cannot compete with the host's
     critical requests — settle alone is not enough, since a mid-load click makes LCP final and lifts
     the moratorium (see `whenNetworkPermitted`). A click during the prefetch joins that load. */
  let cancelPrefetch: (() => void) | undefined;
  whenNetworkPermitted(() => {
    /* Guarded here rather than inside `prefetchStage2`: that module is `shared/`, and stage 2
       imports it. Stage 2 gets its own copy of `phase.ts` whose phase is never advanced, so a
       guard living there would throw on every panel open in the dev arm. */
    if (__DEV__) assertSettled("prefetching stage 2");
    cancelPrefetch = prefetchStage2();
    /* Registration is a network fetch for the worker file plus an install event, so it waits
       for settle exactly as the prefetch does. Deliberately not awaited and deliberately not
       reported: a host with no worker path, no HTTPS, or a scope of their own is in a
       supported state, not an error one, and the panel reads the outcome from
       `tier2State()` when it opens. */
    if (__DEV__) assertSettled("registering the service worker");
    void startTier2(config.sw ?? {});
    /* Tier 4, on the same settle boundary and for the same reason: reading the API global and
       attaching a processor are derivations, and derivations do not run while the host's load
       phase is being measured. Cheap on the overwhelming majority of pages — one symbol read
       that finds nothing. Not awaited and not reported as an error: `no-sdk` is the ordinary
       state, and the panel reads the outcome from `otelState()` when it opens. */
    detectOtel();
  });

  live = {
    enabled: true,
    /**
     * Teardown, including accumulated state. The reset is not tidiness: `buffered: true` means
     * re-registering re-delivers every entry the page ever produced, so without it a second `init()`
     * describes two pages — resources pushed into a ring that still holds the first copy, shifts
     * rejoining a CLS session that contains them, `loafCount` doubled. Not exotic: dev module reload
     * and SPA test harnesses both do it. Observers disconnect first, so nothing writes into a module
     * being reset half-way through.
     */
    destroy() {
      cancelPrefetch?.();
      stopShortcut();
      panel?.destroy();
      panel = undefined;
      pill.destroy();
      stopObserving();
      stopPhase();
      resetPhase();
      resetRing();
      resetVitals();
      resetIntern();
      resetCorrelation();
      resetSelfCost();
      resetSpanSink();
      resetOtel();
      resetTier2();
      resetEpoch();
      live = undefined;
      liveConfig = undefined;
    },
    diagnostics() {
      const ring = stats();
      const interned = internStats();
      return {
        phase: currentPhase(),
        entryTypes: activeEntryTypes(),
        epochSource: epochSource(),
        self: selfCost(),
        tier2: tier2State(),
        otel: otelState(),
        requests: size(),
        dropped: ring.dropped,
        interned: interned.size,
        internOverflows: interned.overflows,
        scheduling: scheduleMode(),
        panelDetach: "documentPictureInPicture" in globalThis,
      };
    },
  };
  return live;
}

/** Tears down a running toolbar. Safe to call when nothing is running. */
export function destroy(): void {
  live?.destroy();
}

/**
 * The running toolbar's diagnostics, without holding its handle.
 *
 * The IIFE build starts itself from its script tag, so nobody holds the handle `init()` returned
 * and there was no way to ask a self-started toolbar what it is made of. Reaching it through a
 * second `init()` is not the answer: with a different config that throws under `__DEV__`, and with
 * the same one it makes a read look like a start.
 */
export function diagnostics(): Diagnostics {
  return (live ?? inert).diagnostics();
}
