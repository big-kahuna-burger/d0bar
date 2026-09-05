import { beforeEach, describe, expect, it } from "vitest";
import { detectOtel, resetOtel, otelState } from "../../src/collector/otel";
import { resetPhase, settleNow } from "../../src/collector/phase";

/**
 * Tier 4 detection.
 *
 * The fakes below are not invented shapes — each one reproduces a configuration measured
 * against the real packages on 2026-09-05 and recorded in the change's `design.md`:
 *
 *   sdk-trace-base 1.30.1  ProxyTracerProvider -> BasicTracerProvider, addSpanProcessor present
 *   sdk-trace-web  2.11.0  ProxyTracerProvider -> WebTracerProvider,   addSpanProcessor absent
 *   api loaded, nothing registered              the global does not exist at all
 *
 * The property that matters most here is a negative one: no test may reach an OpenTelemetry
 * package, because d0bar does not depend on one. Everything is a plain object.
 */

const API_SYMBOL = Symbol.for("opentelemetry.js.api.1");

/** A page with an OTel API registered, whose provider is or is not extendable. */
function pageWith(delegate: unknown, over: Record<string, unknown> = {}): object {
  return {
    [API_SYMBOL]: {
      /* Measured as the *API* package's version — 1.9.1 against both a 1.x and a 2.x SDK. */
      version: "1.9.1",
      trace: { getDelegate: () => delegate },
      ...over,
    },
  };
}

const attachable = { getTracer: () => ({}), addSpanProcessor: () => {} };
const sealed = { getTracer: () => ({}) };

beforeEach(() => {
  resetPhase();
  settleNow();
  resetOtel();
});

describe("finding the host's SDK", () => {
  it("reports no SDK on a page that has none", () => {
    /* The ordinary case, and not a degradation: most pages have no OTel SDK and are entitled
       to a toolbar that says so plainly rather than implying something is broken. */
    expect(detectOtel({})).toEqual({ kind: "off", reason: "no-sdk" });
  });

  it("reports no SDK when the API was bundled but never started", () => {
    /* Measured: importing `@opentelemetry/api` does not create the global — registering a
       provider does. So this is indistinguishable from having no SDK, and saying "no SDK" is
       the truthful statement about a page whose SDK produces nothing. */
    expect(detectOtel({ [Symbol.for("something.else")]: {} })).toEqual({
      kind: "off",
      reason: "no-sdk",
    });
  });

  it("adopts a provider that accepts a processor", () => {
    expect(detectOtel(pageWith(attachable))).toEqual({ kind: "live", owner: "d0bar" });
  });

  it("reports a sealed provider rather than reaching into it", () => {
    /* The 2.x default, and the case that inverts the design: `addSpanProcessor` is gone, and
       the only way to self-attach is the provider's own `_activeSpanProcessor` field. That is
       the monkey-patching this tier refuses, so the answer is a reported state. */
    expect(detectOtel(pageWith(sealed))).toEqual({ kind: "off", reason: "provider-sealed" });
  });
});

describe("what detection refuses to infer", () => {
  it("does not branch on the API version", () => {
    /* The symbol's `version` is the API package's, measured at 1.9.1 against a 1.x SDK *and*
       a 2.x one. A version branch would take the attachable path on a sealed provider and
       report tier 4 live while having attached nothing at all. */
    const oldApiSealed = pageWith(sealed, { version: "1.9.1" });
    const newApiAttachable = pageWith(attachable, { version: "1.9.1" });
    expect(detectOtel(oldApiSealed).kind).toBe("off");
    expect(detectOtel(newApiAttachable).kind).toBe("live");
  });

  it("tests the unwrapped delegate, not the proxy", () => {
    /* The registered `trace` is a ProxyTracerProvider on every line measured, and the proxy
       never has `addSpanProcessor` whatever it wraps. Testing it would report every host on
       earth as sealed. */
    const proxyLooksSealed = {
      [API_SYMBOL]: { version: "1.9.1", trace: { getDelegate: () => attachable } },
    };
    expect(detectOtel(proxyLooksSealed)).toEqual({ kind: "live", owner: "d0bar" });
  });

  it("accepts a registration whose key set is not the full one", () => {
    /* Three lines measured produced three different key sets — `context` and `propagation`
       appear only once a provider registers them. Requiring all of them would reject a valid
       1.x registration. */
    const minimal = { [API_SYMBOL]: { trace: { getDelegate: () => attachable } } };
    expect(detectOtel(minimal)).toEqual({ kind: "live", owner: "d0bar" });
  });
});

describe("degrading rather than throwing", () => {
  it("treats a global that throws on read as absent", () => {
    const hostile = {};
    Object.defineProperty(hostile, API_SYMBOL, {
      get() {
        throw new Error("hardened page");
      },
    });
    expect(detectOtel(hostile)).toEqual({ kind: "off", reason: "no-sdk" });
  });

  it("treats a delegate that throws as no provider", () => {
    const broken = {
      [API_SYMBOL]: {
        trace: {
          getDelegate() {
            throw new Error("nope");
          },
        },
      },
    };
    expect(detectOtel(broken)).toEqual({ kind: "off", reason: "no-provider" });
  });

  it("treats a non-object API global as absent", () => {
    expect(detectOtel({ [API_SYMBOL]: 42 })).toEqual({ kind: "off", reason: "no-sdk" });
    expect(detectOtel({ [API_SYMBOL]: null })).toEqual({ kind: "off", reason: "no-sdk" });
  });

  it("remembers the last outcome for the panel to read", () => {
    detectOtel(pageWith(attachable));
    expect(otelState()).toEqual({ kind: "live", owner: "d0bar" });
    detectOtel({});
    expect(otelState()).toEqual({ kind: "off", reason: "no-sdk" });
  });
});

describe("the load-phase moratorium", () => {
  it("refuses to run before settle", () => {
    /* Detection derives and decides, so it is not one of the things permitted during the load
       phase. In development that is an exception, not a silent allowance. */
    resetPhase();
    expect(() => detectOtel(pageWith(attachable))).toThrow(/load phase/);
  });
});

describe("attachment", () => {
  it("installs the sink into a provider that accepts one", () => {
    const installed: unknown[] = [];
    const provider = {
      getTracer: () => ({}),
      addSpanProcessor: (processor: unknown) => installed.push(processor),
    };
    expect(detectOtel(pageWith(provider))).toEqual({ kind: "live", owner: "d0bar" });

    /* Attached, once, and with the read-only sink rather than anything that exports. */
    expect(installed).toHaveLength(1);
    const sink = installed[0] as Record<string, unknown>;
    expect(typeof sink.onEnd).toBe("function");
    expect(typeof sink.forceFlush).toBe("function");
    expect(sink.export).toBeUndefined();
  });

  it("calls addSpanProcessor on the provider, not on the proxy", () => {
    /* The proxy has no `addSpanProcessor` at all, so a call bound to the wrong receiver would
       fail on a real SDK where it happens to work on a plain object literal. */
    const seen: unknown[] = [];
    const provider = {
      getTracer: () => ({}),
      addSpanProcessor(this: unknown) {
        /* Pushed rather than assigned to a local: `no-this-alias` forbids the assignment, and
           the receiver is what this test is about. */
        seen.push(this);
      },
    };
    detectOtel(pageWith(provider));
    expect(seen).toEqual([provider]);
  });

  it("reports attach-failed, not live, when the provider throws on the call", () => {
    /* A provider that has been shut down does exactly this. Reporting `live` here would put a
       tier badge on a panel that will never receive a span. */
    const provider = {
      getTracer: () => ({}),
      addSpanProcessor: () => {
        throw new Error("provider has shut down");
      },
    };
    expect(detectOtel(pageWith(provider))).toEqual({
      kind: "off",
      reason: "attach-failed",
    });
  });

  it("patches nothing on a sealed provider", () => {
    const provider = { getTracer: () => ({}) };
    const before = Object.keys(provider);
    expect(detectOtel(pageWith(provider))).toEqual({
      kind: "off",
      reason: "provider-sealed",
    });
    /* The 2.x default. Left exactly as it was found — no `_activeSpanProcessor`, no new key. */
    expect(Object.keys(provider)).toEqual(before);
  });
});

describe("the host-installed processor", () => {
  it("makes tier 4 live with the host as owner", async () => {
    const { otelSpanProcessor } = await import("../../src/collector/otel");
    otelSpanProcessor();
    expect(otelState()).toEqual({ kind: "live", owner: "host" });
  });

  it("returns the same processor every time it is asked", async () => {
    const { otelSpanProcessor } = await import("../../src/collector/otel");
    expect(otelSpanProcessor()).toBe(otelSpanProcessor());
  });

  it("is not demoted to sealed when detection runs afterwards", async () => {
    /* A host who installed the processor has a provider that is sealed by construction, so
       running the ladder against it would report a tier that is collecting spans as off. */
    const { otelSpanProcessor } = await import("../../src/collector/otel");
    otelSpanProcessor();
    expect(detectOtel(pageWith(sealed))).toEqual({ kind: "live", owner: "host" });
  });
});
