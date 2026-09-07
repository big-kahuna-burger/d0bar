// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTier2, startTier2, tier2State, noteWorkerRecords } from "../../src/collector/sw";
import { resolveTiers, traceJumpAvailable } from "../../src/panel/tier";
import { resetPhase, settleNow } from "../../src/collector/phase";

/**
 * Tier 2's third state: **registered, and not observing yet.**
 *
 * The bug these lock down shipped and was invisible. `startTier2` reported `live` the moment
 * `register()` resolved — but a service worker never controls the page that registered it, so
 * `controller` is null until the next navigation and no `fetch` event reaches the worker. The
 * panel said "2 SW live" while every row in the requests list read untraced, on every first
 * visit, and there was no state in the model that could say otherwise.
 *
 * What makes this testable at all is that the reading is now derived from
 * `navigator.serviceWorker.controller` at read time rather than cached at registration time —
 * so a test can move the controller and watch the answer change without a browser.
 */

interface FakeContainer {
  controller: { scriptURL: string } | null;
  getRegistration: () => Promise<unknown>;
  register: (path: string) => Promise<unknown>;
}

let container: FakeContainer;

function install(over: Partial<FakeContainer> = {}): void {
  container = {
    controller: null,
    getRegistration: () => Promise.resolve(undefined),
    register: (path: string) => Promise.resolve({ active: { scriptURL: path }, scope: "/" }),
    ...over,
  };
  vi.stubGlobal("navigator", { serviceWorker: container });
  /* `startTier2` refuses an insecure context before it looks at anything else. */
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("self", { isSecureContext: true });
}

beforeEach(() => {
  resetTier2();
  /* `startTier2` calls `assertSettled` in dev — registration during the load phase is exactly
     the kind of distortion this repo forbids. Every case here is about what happens *after*
     registration, so settle first rather than weaken the guard. */
  resetPhase();
  settleNow();
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetTier2();
  resetPhase();
});

describe("a freshly registered worker", () => {
  it("is pending, not live, while nothing controls the page", async () => {
    await startTier2({ path: "/d0bar-sw.js" });

    /* The assertion the old model could not make. `register()` resolved, so the registration
       succeeded — and the tier still cannot see a request. */
    expect(tier2State()).toEqual({ kind: "pending", reason: "awaiting-control" });
  });

  it("becomes live once a controller appears, with no event and no re-registration", async () => {
    await startTier2({ path: "/d0bar-sw.js" });
    expect(tier2State().kind).toBe("pending");

    /* What a reload does. Nothing here calls back into `startTier2`: the reading is derived, so
       it corrects itself — which is why this file adds no `controllerchange` listener. */
    container.controller = { scriptURL: "https://host.test/d0bar-sw.js" };

    expect(tier2State()).toEqual({ kind: "live", owner: "d0bar" });
  });

  it("reports pending rather than throwing when the container is unreachable", async () => {
    await startTier2({ path: "/d0bar-sw.js" });
    Object.defineProperty(container, "controller", {
      get() {
        throw new Error("partitioned");
      },
    });
    /* A partitioned context can throw on the container. Understating is the safe direction:
       claiming `live` here would be the original bug with a different cause. */
    expect(tier2State().kind).toBe("pending");
  });
});

describe("an existing registration", () => {
  it("is pending when it is d0bar's own worker but it is not in control", async () => {
    install({
      getRegistration: () => Promise.resolve({ active: { scriptURL: "/d0bar-sw.js" } }),
    });
    await startTier2({ path: "/d0bar-sw.js" });
    /* The developer case: a rebuild rewrote the worker file, the new version installed and is
       waiting, and this page is controlled by nothing. */
    expect(tier2State().kind).toBe("pending");
  });

  it("is live when d0bar's own worker is in control", async () => {
    install({
      controller: { scriptURL: "https://host.test/d0bar-sw.js" },
      getRegistration: () => Promise.resolve({ active: { scriptURL: "/d0bar-sw.js" } }),
    });
    await startTier2({ path: "/d0bar-sw.js" });
    expect(tier2State()).toEqual({ kind: "live", owner: "d0bar" });
  });
});

describe("a host-owned worker", () => {
  it("stays live without a controller check, because records are the evidence", async () => {
    install({
      getRegistration: () => Promise.resolve({ active: { scriptURL: "/their-sw.js" } }),
    });
    await startTier2({ path: "/d0bar-sw.js" });
    expect(tier2State()).toEqual({ kind: "off", reason: "scope-owned" });

    noteWorkerRecords(true);
    /* No controller is set, and this is still `live` — deliberately. `noteWorkerRecords(true)`
       means records are actually arriving, and an observation outranks a capability check. */
    expect(container.controller).toBeNull();
    expect(tier2State()).toEqual({ kind: "live", owner: "host" });
  });
});

describe("what the panel does with it", () => {
  it("gives the tier strip a fourth state whose label names the remedy", () => {
    const [, row] = resolveTiers(
      { kind: "pending", reason: "awaiting-control" },
      {
        kind: "off",
        reason: "no-sdk",
      },
    );

    expect(row!.state).toBe("pending");
    /* In the label, not only the tooltip. The whole failure was that nothing on screen said
       anything was wrong, and a tooltip is not where an action belongs. */
    expect(row!.label).toContain("reload");
    expect(row!.detail).toContain("not controlling this page");
    /* Must not read as a permanent property of the origin — that is the `off` copy's job, and
       it would send someone hunting a CSP rule that is not the problem. */
    expect(row!.detail).not.toContain("unavailable on this origin");
  });

  it("does not offer a trace jump while pending", () => {
    /* Pending means no traceparent was ever seen, so a jump would resolve to "not found" and
       read as a claim about the backend. */
    expect(traceJumpAvailable({ kind: "pending", reason: "awaiting-control" })).toBe(false);
    expect(traceJumpAvailable({ kind: "live", owner: "d0bar" })).toBe(true);
  });

  it("still labels the two genuine off states as off", () => {
    for (const reason of ["scope-owned", "registration-failed"] as const) {
      const [, row] = resolveTiers({ kind: "off", reason }, { kind: "off", reason: "no-sdk" });
      expect(row!.state).toBe("off");
      expect(row!.label).toBe("2 SW off");
    }
  });
});
