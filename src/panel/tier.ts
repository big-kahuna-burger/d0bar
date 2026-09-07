import type { Tier2Blocked, Tier2Pending, Tier2State } from "../collector/sw";
import type { OtelState } from "../shared/stage2";

/**
 * Tier state, resolved from real capability checks.
 *
 * The footer strip is the toolbar's central honesty claim: four tiers, always all four
 * visible, each in exactly one of three states, and an inactive tier never presented as
 * active. This module is where that resolution happens — the panel paints what it returns
 * and decides nothing on its own.
 *
 * `planned` is not a synonym for `off`. Off means the capability exists and is unavailable
 * here, with a reason worth reading. Planned means d0bar has not built it yet, and saying
 * "off" would blame the host's environment for our own backlog.
 *
 * `pending` is not a synonym for either, and it is the newest of the four for a bad reason:
 * tier 2 used to report `live` from the moment `register()` resolved, which is before the
 * worker controls the page and therefore before it can see a single request. The panel claimed
 * to be observing while every row read untraced. A tier that is going to work shortly is not
 * off, and it is certainly not live — it is the one state the strip can also tell you how to
 * fix, so it says so.
 */

export type TierState = "live" | "pending" | "off" | "planned";

export interface Tier {
  label: string;
  state: TierState;
  /** Shown in the tier's tooltip. States what is missing, never a likely cause. */
  detail: string;
}

/** Copy for each way tier 2 can be unavailable, carried verbatim into the tooltip. */
const BLOCKED_COPY: Record<Tier2Blocked, string> = {
  unsupported:
    "This browser does not support service workers, so no request headers are visible.",
  "insecure-context":
    "Service workers require a secure context. This page is not on HTTPS or localhost, so tier 2 cannot start here.",
  "scope-owned":
    "This origin already has a service worker, and it belongs to the host page. d0bar never takes or unregisters someone else's scope. To turn tier 2 on, import d0bar's worker module into the existing worker.",
  "registration-failed":
    "The worker file could not be registered — it is missing, served with the wrong MIME type, or forbidden by the page's CSP.",
  "not-registered":
    "No worker path is configured, so d0bar has not registered one. Tier 2 needs a same-origin worker file the host serves.",
};

const TIER_2_LIVE_D0BAR =
  "d0bar's own service worker is observing requests. It reads headers and returns — it never calls respondWith, so the browser services every request exactly as it would without it.";

/**
 * Copy for tier 2 registered but not observing.
 *
 * Names the remedy, which no other tier state can: everything else here is a property of the
 * host's environment that a developer either can or cannot change, and this one clears itself on
 * the next navigation.
 */
const PENDING_COPY: Record<Tier2Pending, string> = {
  "awaiting-control":
    "d0bar's service worker is registered but is not controlling this page yet, so it cannot see any requests and every row will read as untraced. Registering a worker and having it control this page are two separate events; d0bar's worker claims the page as soon as it activates, so this usually clears on its own within a moment. If it does not, reload — that always hands control over, and a worker file that changed installs a new version which waits until you do.",
};

const TIER_2_LIVE_HOST =
  "The host page's own service worker imported d0bar's module, so tier 2 is live inside a worker d0bar does not own.";

/**
 * Copy for each way tier 4 can be unavailable.
 *
 * `no-sdk` is deliberately not written as a degradation. The overwhelming majority of pages
 * have no OpenTelemetry SDK and are entitled to a toolbar that says so plainly instead of
 * implying the host has misconfigured something — the tier is off because there is nothing
 * to adopt, not because anything failed.
 */
const OTEL_BLOCKED_COPY: Record<
  "no-sdk" | "no-provider" | "provider-sealed" | "attach-failed",
  string
> = {
  "no-sdk":
    "This page has no OpenTelemetry SDK registered, so there are no spans to adopt. That is the ordinary case and nothing is wrong: d0bar will never install an SDK to create some, because a browser SDK patches fetch and XMLHttpRequest and this toolbar does not.",
  "no-provider":
    "An OpenTelemetry API is registered but does not resolve to a tracer provider, so there is nothing to attach to.",
  "provider-sealed":
    "This page's tracer provider takes its span processors at construction and offers no supported way to add one afterwards, which is the default on the 2.x line. d0bar will not reach into its internals. To turn tier 4 on, pass D0bar.otelSpanProcessor() in the provider's spanProcessors array.",
  "attach-failed":
    "The tracer provider accepted a span processor and then rejected the call, which is what a provider that has already shut down does. Nothing was patched and nothing is collected.",
};

const TIER_4_LIVE_D0BAR =
  "d0bar attached a read-only span processor to the host's own tracer provider. It records five fields per span and exports nothing — no second exporter, no extra network, and the span object is not retained.";

const TIER_4_LIVE_HOST =
  "The host installed d0bar's span processor into their own provider, so tier 4 is live inside an SDK d0bar does not own.";

/**
 * Resolves all four tiers.
 *
 * Tier 1 is unconditional: `PerformanceObserver` is the timing spine and is never absent —
 * every other tier only ever adds to it. Tier 3 is `planned` because nothing is wired to it,
 * which is a statement about this codebase rather than about the host.
 */
function tier2Row(tier2: Tier2State): Tier {
  if (tier2.kind === "live") {
    return {
      label: "2 SW",
      state: "live",
      detail: tier2.owner === "d0bar" ? TIER_2_LIVE_D0BAR : TIER_2_LIVE_HOST,
    };
  }
  if (tier2.kind === "pending") {
    /* "reload" in the label, not only in the tooltip. This is the one tier state with an action
       attached, and a tooltip is not where an action belongs — the whole reason this state exists
       is that the previous reading told nobody anything was wrong. */
    return { label: "2 SW — reload", state: "pending", detail: PENDING_COPY[tier2.reason] };
  }
  /* The label states the degradation too, not only the dot — a screenshot, a monochrome display
     and a colour-blind reader all lose the dot. */
  return { label: "2 SW off", state: "off", detail: BLOCKED_COPY[tier2.reason] };
}

export function resolveTiers(tier2: Tier2State, otel: OtelState): Tier[] {
  return [
    {
      label: "1 PerformanceObserver",
      state: "live",
      detail:
        "The timing spine: every request and every vital, read from the browser rather than intercepted. buffered: true means entries from before the toolbar mounted are included.",
    },
    tier2Row(tier2),
    {
      label: "3 Server-Timing",
      state: "planned",
      detail:
        "Would carry the server's own phases on the response, turning one opaque wait bar into server-side segments. Not built yet, so it supplies nothing.",
    },
    otel.kind === "live"
      ? {
          label: "4 OTel SDK",
          state: "live",
          detail: otel.owner === "d0bar" ? TIER_4_LIVE_D0BAR : TIER_4_LIVE_HOST,
        }
      : {
          /* Like tier 2's, the label carries the state as well as the dot — a screenshot, a
             monochrome display and a colour-blind reader all lose the dot. */
          label: "4 OTel SDK off",
          state: "off",
          detail: OTEL_BLOCKED_COPY[otel.reason],
        },
  ];
}

/**
 * Whether a trace jump can be offered at all.
 *
 * Without tier 2 there is no `traceparent`, so there is no trace id, so every request
 * resolves to the no-span state — not to "trace not found", which would be a claim about the
 * backend, and not to a spinner, which would imply one is coming.
 */
export function traceJumpAvailable(tier2: Tier2State): boolean {
  return tier2.kind === "live";
}
