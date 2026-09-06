import { assertSettled } from "./phase";
import { createSpanSink, type ReadOnlySpanProcessor } from "./otel-sink";

/**
 * Tier 4 — adopting the host's own OpenTelemetry spans. **d0bar never installs an SDK**: an OTel
 * browser SDK patches `fetch` and `XHR`, legitimate for a customer who chose it and illegitimate
 * for a toolbar measuring the page. This reads a provider the host registered, or reports there is
 * none. No OpenTelemetry package is imported — the API is a global or it is absent, which is what
 * makes tier 4 free for pages with no SDK.
 *
 * Three outcomes, the same shape as scope contention in `sw.ts` — a host-owned resource d0bar may
 * use but never seize:
 *
 *   1. no API registered            → off, `no-sdk`          (the ordinary case)
 *   2. provider accepts a processor → live, owner `d0bar`
 *   3. provider is sealed           → host installs ours     → live, owner `host`
 *                                     or does not            → off, `provider-sealed`
 *
 * Outcome 3 is the common one, not an edge case: measured 2026-09-05, `@opentelemetry/sdk-trace-web`
 * 2.11.0 has `addSpanProcessor === undefined` — 2.x takes processors at construction only. The lone
 * way to self-attach there is reaching into `_activeSpanProcessor`, the monkey-patching this file
 * exists to refuse.
 */

/** Where `@opentelemetry/api` registers itself. Versioned by design, so it is matched exactly. */
const API_SYMBOL = "opentelemetry.js.api.1";

export type OtelState =
  { kind: "live"; owner: "d0bar" | "host" } | { kind: "off"; reason: OtelBlocked };

/** Why tier 4 is unavailable. Each maps to copy the panel shows verbatim. */
export type OtelBlocked =
  /* No OpenTelemetry API is registered. Not a degradation — most pages are this, and it also
     covers an SDK that was imported and never started: measured, the global does not exist at
     all until something registers a provider on it. */
  | "no-sdk"
  /* A `trace` that does not unwrap to a usable provider. Defensive — no measured configuration
     produced it — but kept distinct so it is never mislabelled as sealed, which would send a host
     to install a processor they do not need. */
  | "no-provider"
  /* The provider cannot take a processor after construction, and the host has not installed
     d0bar's own. The 2.x default. */
  | "provider-sealed"
  /* Offered `addSpanProcessor`, then threw on the call — a shut-down provider does this. Distinct
     from `provider-sealed`: that one needs the host to install `otelSpanProcessor()`, this one
     needs nothing, because its SDK has stopped. */
  | "attach-failed";

let state: OtelState = { kind: "off", reason: "no-sdk" };

export function otelState(): OtelState {
  return state;
}

/**
 * The shape read off the global: only the members touched, so a change elsewhere in the API cannot
 * affect this module. All optional because the key set genuinely varies — `context` and
 * `propagation` appear only once a provider registers them, and a fixed-shape check would reject a
 * good 1.x registration.
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
 * What is written into the ring per adopted span: primitives only, copied out, span dropped. A
 * `ReadableSpan` holds its attributes, links, events and the whole resource — retaining one retains
 * all of it, on a page whose memory is not ours to spend.
 */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  url: string;
  startTime: number;
  endTime: number;
}

/**
 * The processor a host installs themselves — the analogue of `d0bar-sw-module`: where d0bar cannot
 * reach in, the host reaches out. On 2.x, processors are construction-time only, so this is the
 * *primary* path, not an exotic fallback:
 *
 * ```js
 * import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
 * const provider = new WebTracerProvider({ spanProcessors: [D0bar.otelSpanProcessor()] });
 * provider.register();
 * ```
 *
 * Calling this is what makes tier 4 live with owner `host`. It is idempotent — a host that
 * calls it twice installs the same sink twice into their own provider, which double-counts
 * nothing because both calls return the one processor.
 */
export function otelSpanProcessor(): ReadOnlySpanProcessor {
  if (!sink) sink = createSpanSink();
  /* A host who installed the processor has made tier 4 live by doing so, whatever the
     provider's own shape says. Recorded here rather than inferred later: by the time the
     panel asks, the provider is sealed and looks identical to one that refused us. */
  state = { kind: "live", owner: "host" };
  return sink;
}

/** The sink, created on first use. Absent on the overwhelming majority of pages. */
let sink: ReadOnlySpanProcessor | undefined;

/**
 * Reads the registered provider, attaches the sink where supported, reports why where not. Never
 * throws: no SDK, a failed registration and a sealed provider are three supported states and the
 * panel says which. Nothing is patched — the only mutation attempted is the provider's own
 * `addSpanProcessor`, and a provider without it is left untouched and reported sealed.
 */
export function detectOtel(scope: object = globalThis): OtelState {
  /* Detection is a derivation and a decision, so it is not permitted during the load phase —
     the same rule that governs everything except recording an entry. */
  if (__DEV__) assertSettled("OpenTelemetry detection");

  /* A host who installed `otelSpanProcessor()` themselves is already live, and their provider
     is sealed by construction — running the ladder below would demote them to
     `provider-sealed` and report a tier that is collecting spans as off. */
  if (state.kind === "live" && state.owner === "host") return state;

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
  const add = (delegate as Attachable).addSpanProcessor;
  if (typeof add === "function") {
    if (!sink) sink = createSpanSink();
    try {
      (add as (processor: ReadOnlySpanProcessor) => void).call(delegate, sink);
    } catch {
      /* Reported, not swallowed into a live state: the method existed and the call was refused,
         so d0bar is not attached, and "live" would badge a panel that never receives a span. */
      state = { kind: "off", reason: "attach-failed" };
      return state;
    }
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
 * Unwraps the `ProxyTracerProvider` to reach the real one. Required, not a refinement: measured,
 * `trace` is a proxy on every line tested, and the proxy has no `addSpanProcessor` regardless of
 * what it wraps — testing it would read every host as sealed.
 *
 * No-op delegates are not detected. An unregistered proxy returns `NoopTracerProvider`, which is
 * not distinguishable by surface, but that state is unreachable: no global exists until something
 * registers, so `readApi` already returned `no-sdk`. Class-name matching is the alternative, and a
 * host's minifier renames it.
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

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetOtel(): void {
  state = { kind: "off", reason: "no-sdk" };
  sink = undefined;
}
