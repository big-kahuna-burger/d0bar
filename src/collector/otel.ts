import { assertSettled } from "./phase";

/**
 * Tier 4 — adopting the host's own OpenTelemetry spans.
 *
 * The constraint is the design: **d0bar never installs an SDK.** An OTel browser SDK patches
 * `fetch` and `XMLHttpRequest`; that is a legitimate cost for a customer who chose it and an
 * illegitimate one for a toolbar measuring the page. So this module reads a provider the host
 * already registered, or reports that there is none. It imports no OpenTelemetry package —
 * the API is a global or it is absent, which is what makes tier 4 free for the overwhelming
 * majority of pages that have no SDK at all.
 *
 * Three outcomes, mirroring scope contention in `sw.ts` because it is the same shape of
 * problem — a resource the host owns, which d0bar may use but never seize:
 *
 *   1. no API registered            → tier 4 off, `no-sdk`      (the ordinary case)
 *   2. provider accepts a processor → d0bar attaches            → live, owner `d0bar`
 *   3. provider is sealed           → the host installs ours    → live, owner `host`
 *                                     or does not               → off, `provider-sealed`
 *
 * Outcome 3 is not an edge case. Measured 2026-09-05 against `@opentelemetry/sdk-trace-web`
 * 2.11.0 — what a browser host actually installs — `addSpanProcessor` is `undefined`: the 2.x
 * line takes its processors at construction and exposes no supported way to add one
 * afterwards. Self-attachment is the legacy path; the host-installed processor is the real
 * one. The only way to self-attach on 2.x is to reach into the provider's own
 * `_activeSpanProcessor` field, which is precisely the monkey-patching this file exists to
 * refuse.
 */

/** Where `@opentelemetry/api` registers itself. Versioned by design, so it is matched exactly. */
const API_SYMBOL = "opentelemetry.js.api.1";

export type OtelState =
  | { kind: "live"; owner: "d0bar" | "host" }
  | { kind: "off"; reason: OtelBlocked };

/** Why tier 4 is unavailable. Each maps to copy the panel shows verbatim. */
export type OtelBlocked =
  /* No OpenTelemetry API is registered. Not a degradation — most pages are this, and it also
     covers an SDK that was imported and never started: measured, the global does not exist at
     all until something registers a provider on it. */
  | "no-sdk"
  /* The global carries a `trace` that does not unwrap to a usable provider. Defensive: no
     measured configuration produced it, since registration is what creates the global in the
     first place. Kept distinct so that if it ever happens it is not mislabelled as a sealed
     provider, which would send a host to install a processor they do not need. */
  | "no-provider"
  /* The provider cannot take a processor after construction, and the host has not installed
     d0bar's own. The 2.x default. */
  | "provider-sealed";

let state: OtelState = { kind: "off", reason: "no-sdk" };

export function otelState(): OtelState {
  return state;
}

/**
 * The shape d0bar reads off the global.
 *
 * Structural and minimal on purpose: these are the only members touched, so a change anywhere
 * else in the API cannot affect this module. Every one is optional because the symbol's key
 * set genuinely varies — `context` and `propagation` appear only once a provider registers
 * them, so a fixed-shape check would reject a perfectly good 1.x registration.
 */
interface ApiGlobal {
  version?: unknown;
  trace?: ProxyLike;
}

interface ProxyLike {
  /* The registered `trace` is a `ProxyTracerProvider` on every line measured, so unwrapping is
     required before any capability test — testing the proxy would test the wrong object. */
  getDelegate?: () => unknown;
}

interface Attachable {
  addSpanProcessor?: unknown;
}

/**
 * What d0bar writes into the ring for each adopted span.
 *
 * Primitives only, copied out and the span dropped. A `ReadableSpan` holds its attributes,
 * links, events and the whole resource; retaining one to read later would retain all of it,
 * on a page whose memory is not ours to spend.
 */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  url: string;
  startTime: number;
  endTime: number;
}

/**
 * Reads the registered provider, or reports why there is none.
 *
 * Never throws. A page with no SDK, a page whose SDK failed to register, and a page whose
 * provider is sealed are three different supported states, and the panel says which.
 */
export function detectOtel(scope: object = globalThis): OtelState {
  /* Detection is a derivation and a decision, so it is not permitted during the load phase —
     the same rule that governs everything except recording an entry. */
  assertSettled("OpenTelemetry detection");

  const api = readApi(scope);
  if (!api) {
    state = { kind: "off", reason: "no-sdk" };
    return state;
  }

  const delegate = unwrap(api.trace);
  if (!delegate) {
    state = { kind: "off", reason: "no-provider" };
    return state;
  }

  /* Feature-tested on the unwrapped delegate, never inferred from a version. The symbol's
     `version` is the *API* package's, measured as 1.9.1 against both a 1.x and a 2.x SDK —
     branching on it would take the attachable path against a provider that is not. */
  if (typeof (delegate as Attachable).addSpanProcessor === "function") {
    state = { kind: "live", owner: "d0bar" };
    return state;
  }

  state = { kind: "off", reason: "provider-sealed" };
  return state;
}

/** Reads and shape-checks the API global. Returns undefined when it is absent or unusable. */
function readApi(scope: object): ApiGlobal | undefined {
  let candidate: unknown;
  try {
    candidate = (scope as Record<symbol, unknown>)[Symbol.for(API_SYMBOL)];
  } catch {
    /* A hardened page can make a global throw on read. Absent is the honest reading. */
    return undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const api = candidate as ApiGlobal;
  /* `trace` is the only member required. Requiring the full key set would reject a valid
     registration: `context` and `propagation` appear only when a provider registers them, and
     the three lines measured produced three different key sets. */
  if (!api.trace || typeof api.trace !== "object") return undefined;
  return api;
}

/**
 * Unwraps the `ProxyTracerProvider` the API registers, to reach the real provider.
 *
 * Required, not an optional refinement: measured, `trace` on the global is a
 * `ProxyTracerProvider` on every line tested, and a capability test run against the proxy
 * tests the wrong object — the proxy has no `addSpanProcessor` regardless of what it wraps,
 * so every host would have read as sealed.
 *
 * No attempt is made to recognise a no-op delegate. An unregistered proxy does return one —
 * `NoopTracerProvider`, which answers `getTracer` and has no `addSpanProcessor`, so it is not
 * distinguishable by surface — but that state is unreachable from here: the global does not
 * exist until something registers, so `readApi` has already returned `no-sdk`. Matching on the
 * class name would be the alternative, and a host's minifier renames it.
 */
function unwrap(provider: ProxyLike | undefined): unknown {
  if (!provider) return undefined;
  if (typeof provider.getDelegate !== "function") return provider;
  try {
    const delegate = provider.getDelegate();
    if (!delegate || typeof delegate !== "object") return undefined;
    return delegate;
  } catch {
    return undefined;
  }
}

/** Test seam. */
export function resetOtel(): void {
  state = { kind: "off", reason: "no-sdk" };
}
