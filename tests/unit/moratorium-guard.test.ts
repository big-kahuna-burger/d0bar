// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { assertSettled, resetPhase, settleNow } from "../../src/collector/phase";
import { detectOtel, resetOtel } from "../../src/collector/otel";
import { resetTier2, startTier2 } from "../../src/collector/sw";

/**
 * `assertSettled` had exactly one call site, and three documents describing it as though it
 * had many. These are the ones reachable from a unit test — a named test per call site, so
 * deleting a call fails a test that says which one.
 *
 * The two sites this file cannot reach are the pill's DOM write and stage 1's scheduling of
 * the prefetch: both live inside a deferred callback rather than behind a callable entry
 * point, so removing the deferral is the only way to reach them pre-settle. That is what
 * `tests/perf/dev-guard.spec.ts` does, on the `?d0bar=dev` arm — and it was observed failing
 * with the pill's `whenSettled` wrapper removed, reporting
 * "d0bar: mounting the pill attempted during the load phase".
 *
 * `__DEV__` is `true` under vitest (`vitest.config.ts` defines it), which is what makes any
 * of this observable at all.
 */

afterEach(() => {
  resetPhase();
  resetOtel();
  resetTier2();
});

describe("assertSettled", () => {
  it("throws during the load phase and is silent after settle", () => {
    expect(() => assertSettled("a derivation")).toThrow(/during the load phase/);
    settleNow();
    expect(() => assertSettled("a derivation")).not.toThrow();
  });

  it("names the operation, so a violation says what did it", () => {
    expect(() => assertSettled("posting to the layout worker")).toThrow(
      /posting to the layout worker/,
    );
  });
});

describe("guarded call sites", () => {
  it("OpenTelemetry detection refuses to run pre-settle", () => {
    expect(() => detectOtel({})).toThrow(/OpenTelemetry detection/);
    settleNow();
    /* And is a supported, quiet no-op once permitted: an empty scope has no SDK. */
    expect(detectOtel({})).toEqual({ kind: "off", reason: "no-sdk" });
  });

  it("service-worker registration refuses to run pre-settle", async () => {
    /* jsdom has no `serviceWorker` container, and `startTier2` reports `unsupported` and
       returns before ever reaching the guard — so a test without this stub would pass with
       the guard deleted. */
    const registered: string[] = [];
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: () => Promise.resolve(undefined),
        register: (path: string) => {
          registered.push(path);
          return Promise.resolve({ active: null, installing: null, scriptURL: path });
        },
        addEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });

    await expect(startTier2({ path: "/d0bar-sw.js" })).rejects.toThrow(
      /registering the service worker/,
    );
    expect(registered, "nothing was registered").toEqual([]);
  });
});
