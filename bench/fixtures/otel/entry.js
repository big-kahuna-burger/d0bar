/**
 * The fixture's OpenTelemetry host.
 *
 * This file is **the instrument, not the subject**. It is bundled into
 * `bench/fixtures/host/otel-sdk.js` and loaded only by `/otel.html`, which no benchmark
 * visits — the observer-effect arms all run against `/`. Nothing here is shipped, and
 * `@opentelemetry/*` is a dev dependency of the workspace root for exactly this reason: the
 * ESLint rule bans it from `src/**`, and the build fails outright if the string ever appears
 * in an emitted artifact.
 *
 * What it does is what a real customer does, in the order a real customer does it:
 * construct a provider, hand it `D0bar.otelSpanProcessor()` at construction — the only path
 * the 2.x line supports — and register. Everything after that is the SDK's own behaviour.
 */
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { trace } from "@opentelemetry/api";

/**
 * Registers the provider with d0bar's processor installed.
 *
 * Called from the page rather than at module scope so the page controls the ordering: the
 * processor has to exist before any span does, and `D0bar` has to have loaded before the
 * processor can be asked for.
 */
export function install() {
  const provider = new WebTracerProvider({
    /* At construction. `addSpanProcessor` does not exist on this line — measured, and the
       whole reason `otelSpanProcessor()` is public. */
    spanProcessors: [globalThis.D0bar.otelSpanProcessor()],
  });
  provider.register();
  return provider;
}

/**
 * Issues a fetch inside a span the host's own SDK created, exactly as an instrumented
 * application would.
 *
 * Written by hand rather than with `@opentelemetry/instrumentation-fetch`, deliberately: the
 * auto-instrumentation patches `fetch`, and a fixture that patches `fetch` cannot be used to
 * demonstrate that d0bar does not. The span carries `url.full`, which is the attribute tier 4
 * joins on.
 */
export async function tracedFetch(url) {
  const tracer = trace.getTracer("fixture");
  const span = tracer.startSpan("GET " + url, { attributes: { "url.full": url } });
  try {
    /* The body is read, not just awaited. A `fetch` whose body is never consumed does not
       produce a `PerformanceResourceTiming` entry in Chromium — measured here, not recalled:
       four unconsumed fetches left the resource timeline empty while a fifth that called
       `.text()` appeared immediately. Tier 1 sees nothing without this, so tier 4 would have
       nothing to join against and the spec would fail for a reason that has nothing to do
       with tier 4. */
    const response = await fetch(url);
    await response.text();
  } finally {
    span.end();
  }
}
