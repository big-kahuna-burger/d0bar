import {
  currentPhase,
  noteFirstInput,
  noteLcpEntry,
  noteLoaded,
  noteVisibilityState,
} from "./phase";
import { pushResource } from "./ring";
import { noteInteraction, noteLayoutShift, noteLcp, noteLoaf, noteNavigation } from "./vitals";
import { beginSelfCost, marked, noteSelfLoaf } from "./selfcost";

/**
 * Tier 1 observation.
 *
 * The browser already records every request with a full timing breakdown, and every vital
 * with attribution. The toolbar reads that rather than recreating it — which is why nothing
 * here patches, wraps, or intercepts anything.
 *
 * This is also the toolbar's only point of contact with the host page. Lifecycle signals that
 * would conventionally be listeners — load, visibility, first input — are taken from entry
 * types instead and routed to `phase.ts`, so nothing in the observation path registers an
 * event listener on `window` or `document`. The toolbar's one listener on the host is the
 * keyboard shortcut in `shortcut.ts`, which is opt-out; `non-perturbation.spec.ts` asserts
 * that it is the only one.
 *
 * Every observer is registered with `buffered: true`, so mounting late still yields every
 * entry from page start. Each entry type is registered in its own try/catch: browsers throw
 * on unknown types, and losing `long-animation-frame` on Safari must not cost us `resource`
 * everywhere.
 */

const observers: PerformanceObserver[] = [];
let reportingObserver: { disconnect(): void } | undefined;

/** Entry types this browser accepted, for the diagnostics surface. */
const active: string[] = [];

/**
 * Notified once after each post-settle batch of resource entries.
 *
 * **This was a single optional slot, and the slot was a bug.** The comment justifying it said
 * there was "exactly one consumer — the open panel", which was true when it was written and
 * stopped being true the day `add-untraced-view` landed a second view that also wants to know
 * when requests arrive. A second `onResourceBatch` overwrote the first with no error and no
 * warning: `panel/index.ts` builds the requests view before the untraced one, so the requests
 * list quietly stopped receiving live updates and showed whatever the ring held at the moment
 * the panel opened. Observed as a list pinned at 273 records while the browser's own resource
 * count climbed past 600.
 *
 * So it is a list, and the cost the old comment feared is worth naming exactly: one indexed
 * loop over two entries, once per *batch* — not per entry — allocating nothing. The hot path's
 * rule is about allocation inside `pushResource`, and this is neither.
 */
const batchListeners: Array<() => void> = [];

/**
 * Registers a resource-batch listener. Returns a teardown that removes it.
 *
 * The listener must be cheap: it runs at the end of an observer callback, on the main
 * thread. The panel's does one boolean write and, at most, one `requestAnimationFrame`.
 */
export function onResourceBatch(fn: () => void): () => void {
  batchListeners.push(fn);
  return () => {
    const at = batchListeners.indexOf(fn);
    if (at !== -1) batchListeners.splice(at, 1);
  };
}

/**
 * The same, for the vitals entry types.
 *
 * Deliberately not the resource list. Sharing it would repaint the requests list on every
 * layout shift — a repaint per shift on the page being measured, to update a list that did
 * not change. The two batches are different events and get different subscriptions.
 */
const vitalsListeners: Array<() => void> = [];

export function onVitalsBatch(fn: () => void): () => void {
  vitalsListeners.push(fn);
  return () => {
    const at = vitalsListeners.indexOf(fn);
    if (at !== -1) vitalsListeners.splice(at, 1);
  };
}

/** Both notifiers, in one shape, so neither can grow a subtly different dispatch. */
function notify(listeners: Array<() => void>): void {
  for (let i = 0; i < listeners.length; i++) listeners[i]!();
}

/** Deprecations, interventions and CSP violations, bounded so a noisy page cannot grow us. */
const REPORT_CAP = 50;
let reportCount = 0;

interface ReportingObserverLike {
  new (
    callback: (reports: unknown[]) => void,
    options: { buffered: boolean; types: string[] },
  ): { observe(): void; disconnect(): void };
}

function observe(
  type: string,
  handle: (entries: PerformanceEntryList) => void,
  options?: Record<string, unknown>,
): void {
  try {
    /* One marked callback covers every observer: this is the single function the browser invokes
       for all of them, so naming it here attributes every tier 1 batch to d0bar at one call
       frame per batch. See `shared/mark.ts`. */
    const observer = new PerformanceObserver(
      marked({
        "d0bar:observe"(list: PerformanceObserverEntryList): void {
          handle(list.getEntries());
        },
      }),
    );
    observer.observe({ type, buffered: true, ...options });
    observers.push(observer);
    active.push(type);
  } catch {
    /* Entry type unsupported on this browser. The tier stack degrades per type, and the
       UI reads `activeEntryTypes()` rather than assuming a set. */
  }
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
}

/** Registers every tier 1 observer. Returns a teardown that disconnects all of them. */
export function startObserving(): () => void {
  observe("resource", (entries) => {
    /* The only work permitted during the load phase: a straight write into the ring. */
    for (let i = 0; i < entries.length; i++) {
      pushResource(entries[i] as PerformanceResourceTiming);
    }
    /* Once per batch, never per entry, and never before settle. The listener exists so an
       open panel learns about new requests without polling every frame; during the load
       phase there is nothing to tell, because stage 2 has not been fetched yet and the
       panel re-reads the whole ring when it opens. Gating on the phase keeps the claim
       about this callback exact rather than nearly true. */
    if (currentPhase() === "settled") notify(batchListeners);
  });

  observe("navigation", (entries) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as PerformanceNavigationTiming;
      noteNavigation(entry);
      /* The navigation entry is delivered twice — first with every field still zero, then
         again once the load event has run, carrying `loadEventEnd`. The second delivery is
         the load signal, which is why this module needs no `load` listener on the host. */
      if (entry.loadEventEnd > 0) noteLoaded();
    }
  });

  /* Visibility as an entry type rather than a `visibilitychange` listener. Registered with
     `buffered: true`, so the initial state arrives as `{ name: "visible", startTime: 0 }`
     without asking the document for it. */
  observe("visibility-state", (entries) => {
    for (let i = 0; i < entries.length; i++) {
      /* The entry's own `startTime` goes with the state: a hidden entry seals LCP at the
         moment the page was hidden, not at the moment the toolbar was told. */
      noteVisibilityState(entries[i]!.name, entries[i]!.startTime);
    }
  });

  observe("largest-contentful-paint", (entries) => {
    for (let i = 0; i < entries.length; i++) noteLcp(entries[i] as PerformanceEntry);
    /* Each entry resets the quiet timer the moratorium waits on. */
    noteLcpEntry();
    notify(vitalsListeners);
  });

  observe("layout-shift", (entries) => {
    for (let i = 0; i < entries.length; i++) {
      noteLayoutShift(entries[i] as LayoutShiftEntry);
    }
    notify(vitalsListeners);
  });

  /* 40ms matches the threshold the platform itself uses for reporting slow interactions. */
  observe(
    "event",
    (entries) => {
      for (let i = 0; i < entries.length; i++) {
        noteInteraction(entries[i] as EventTimingEntry);
      }
      notify(vitalsListeners);
    },
    { durationThreshold: 40 },
  );

  /* One observer, two consumers. `noteLoaf` is the host's reading and `noteSelfLoaf` is d0bar's
     own; a second observer for the same entry type would double the callback the browser has to
     run on the thread both of them are measuring. */
  observe("long-animation-frame", (entries) => {
    for (let i = 0; i < entries.length; i++) {
      noteLoaf(entries[i] as PerformanceEntry);
      noteSelfLoaf(entries[i] as PerformanceEntry);
    }
    notify(vitalsListeners);
  });
  /* After the registration, not before: `observe` swallows an unsupported type, so whether the
     browser accepted it is only knowable from `active`. Asking `supportedEntryTypes` instead would
     be a second, differently-wrong answer — Chromium has listed a type it then refused options for.
     Buffered delivery is a task away, so nothing has arrived yet. */
  beginSelfCost(active.indexOf("long-animation-frame") !== -1);

  /* First input finalizes LCP. Observed as an entry type rather than a listener, so the
     toolbar adds nothing to the host page's event surface. */
  observe("first-input", (entries) => {
    for (let i = 0; i < entries.length; i++) noteFirstInput(entries[i]!.startTime);
  });

  const Reporting = (globalThis as { ReportingObserver?: ReportingObserverLike })
    .ReportingObserver;
  if (Reporting) {
    try {
      const observer = new Reporting(
        (reports) => {
          reportCount = Math.min(REPORT_CAP, reportCount + reports.length);
        },
        { buffered: true, types: ["deprecation", "intervention", "csp-violation"] },
      );
      observer.observe();
      reportingObserver = observer;
    } catch {
      /* Unsupported. */
    }
  }

  return () => {
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    active.length = 0;
    reportingObserver?.disconnect();
    reportingObserver = undefined;
    batchListeners.length = 0;
    vitalsListeners.length = 0;
  };
}

export function activeEntryTypes(): readonly string[] {
  return active;
}

export function reportsSeen(): number {
  return reportCount;
}

/** Test seam. */
export function resetObserve(): void {
  reportCount = 0;
}
