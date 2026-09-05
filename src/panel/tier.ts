import type { Tier2Blocked, Tier2State } from "../collector/sw";

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
 */

export type TierState = "live" | "off" | "planned";

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

const TIER_2_LIVE_HOST =
  "The host page's own service worker imported d0bar's module, so tier 2 is live inside a worker d0bar does not own.";

/**
 * Resolves all four tiers.
 *
 * Tier 1 is unconditional: `PerformanceObserver` is the timing spine and is never absent —
 * every other tier only ever adds to it. Tiers 3 and 4 are `planned` because nothing is
 * wired to them, which is a statement about this codebase rather than about the host.
 */
export function resolveTiers(tier2: Tier2State): Tier[] {
  return [
    {
      label: "1 PerformanceObserver",
      state: "live",
      detail:
        "The timing spine: every request and every vital, read from the browser rather than intercepted. buffered: true means entries from before the toolbar mounted are included.",
    },
    tier2.kind === "live"
      ? {
          label: "2 SW",
          state: "live",
          detail: tier2.owner === "d0bar" ? TIER_2_LIVE_D0BAR : TIER_2_LIVE_HOST,
        }
      : {
          /* The label states the degradation too, not only the dot — a screenshot, a
             monochrome display and a colour-blind reader all lose the dot. */
          label: "2 SW off",
          state: "off",
          detail: BLOCKED_COPY[tier2.reason],
        },
    {
      label: "3 Server-Timing",
      state: "planned",
      detail:
        "Would carry the server's own phases on the response, turning one opaque wait bar into server-side segments. Not built yet, so it supplies nothing.",
    },
    {
      label: "4 OTel SDK",
      state: "planned",
      detail:
        "Would read the spans the host's OpenTelemetry SDK already builds, making the jump from a slow request to its trace a link rather than a search. Not built yet, so it supplies nothing.",
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
