/**
 * Page-side worker registration and tier-2 availability.
 *
 * Three outcomes, in the order the design fixes them:
 *
 *   1. no worker registered        → d0bar registers its own          → tier 2 live
 *   2. host worker imports d0bar   → nothing to register              → tier 2 live
 *   3. host worker will not import → registration refused             → tier 2 off
 *
 * Outcome 3 is a real, supported state, not a failure to route around. The alternative
 * offered by every other toolbar — patch `fetch` and call it correlation — is rejected in
 * `design.md` and must stay rejected here: it changes the calls it observes, misses
 * everything issued before mount, and fights whatever else patched the same global.
 */

import { assertSettled } from "./phase";

export type Tier2State =
  { kind: "live"; owner: "d0bar" | "host" } | { kind: "off"; reason: Tier2Blocked };

/** Why tier 2 is unavailable. Each maps to copy the panel shows verbatim. */
export type Tier2Blocked =
  "unsupported" | "insecure-context" | "scope-owned" | "registration-failed" | "not-registered";

let state: Tier2State = { kind: "off", reason: "not-registered" };

export function tier2State(): Tier2State {
  return state;
}

/**
 * Where the host serves d0bar's worker. Absent, no registration is attempted at all — a
 * toolbar that guesses at a path would 404 against the host's own routing and log an error
 * in a console that is not ours to write to.
 */
export interface SwConfig {
  /** Same-origin path to the worker file, e.g. `/d0bar-sw.js`. */
  path?: string | undefined;
  /** Registration scope. Defaults to the worker file's directory, per the platform. */
  scope?: string | undefined;
}

/**
 * Registers the worker, or resolves why it cannot be.
 *
 * Never rejects, and never unregisters anything. Called only after the load phase has
 * settled — registration triggers a network fetch for the worker file and an install event,
 * and neither belongs in a window where the host's LCP is still being decided.
 */
export async function startTier2(config: SwConfig): Promise<Tier2State> {
  if (!("serviceWorker" in navigator)) {
    state = { kind: "off", reason: "unsupported" };
    return state;
  }
  /* Service workers require a secure context. Reported as its own state rather than folded
     into a generic failure: on a plain-http staging host this is the whole explanation, and
     "registration failed" would send someone looking for a bug that is not there. */
  if (!self.isSecureContext) {
    state = { kind: "off", reason: "insecure-context" };
    return state;
  }

  const container = navigator.serviceWorker;

  /* An existing controller means some worker already owns this scope. If it is d0bar's own
     — a reload, or another tab — tier 2 is already live and there is nothing to do. */
  const existing = await safe(() => container.getRegistration());
  if (existing) {
    const url = existing.active?.scriptURL ?? existing.installing?.scriptURL ?? "";
    if (config.path && url.endsWith(config.path)) {
      state = { kind: "live", owner: "d0bar" };
      return state;
    }
    /* Someone else's worker. Whether it imported d0bar's module is not knowable from here
       without asking it, and it has no obligation to answer — so this is resolved by
       observation instead: `hasWorkerRecords()` reports whether records are actually
       arriving, and the tier is upgraded on the evidence rather than on a claim. */
    state = { kind: "off", reason: "scope-owned" };
    return state;
  }

  if (!config.path) {
    state = { kind: "off", reason: "not-registered" };
    return state;
  }

  /* The actual call, not just its caller. `index.ts` guards the scheduling decision; this
     guards the side effect, so a second registration path added later is caught too. */
  if (__DEV__) assertSettled("registering the service worker");
  const registration = await safe(() =>
    container.register(
      config.path as string,
      config.scope ? { scope: config.scope } : undefined,
    ),
  );
  if (!registration) {
    state = { kind: "off", reason: "registration-failed" };
    return state;
  }

  state = { kind: "live", owner: "d0bar" };
  return state;
}

/**
 * Upgrades a `scope-owned` reading to live when the host's own worker turns out to have
 * imported d0bar's module after all — proven by records existing in the log, not by asking.
 */
export function noteWorkerRecords(present: boolean): void {
  if (present && state.kind === "off" && state.reason === "scope-owned") {
    state = { kind: "live", owner: "host" };
  }
}

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetTier2(): void {
  state = { kind: "off", reason: "not-registered" };
}

async function safe<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    /* Registration throws for a 404, a MIME type the browser will not accept as a worker,
       a CSP that forbids `worker-src`, and a scope wider than the file's path. Every one of
       them is the host's environment telling us tier 2 is unavailable here, which is a
       state to report rather than an error to raise. */
    return undefined;
  }
}
