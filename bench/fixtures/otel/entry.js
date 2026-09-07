/**
 * The fixture's OpenTelemetry host.
 *
 * This file is **the instrument, not the subject**. It is bundled into
 * `bench/fixtures/host/otel-sdk.js` and loaded only by `/otel.html` and `/try/`, which no
 * benchmark visits — the observer-effect arms all run against `/`. Nothing here is shipped, and
 * `@opentelemetry/*` is a dev dependency of the workspace root for exactly this reason: the
 * ESLint rule bans it from `src/**`, and the build fails outright if the string ever appears
 * in an emitted artifact.
 *
 * What it does is what a real customer does, in the order a real customer does it: construct a
 * provider, hand it `D0bar.otelSpanProcessor()` at construction — the only path the 2.x line
 * supports — and register. Everything after that is the SDK's own behaviour.
 *
 * **Export goes to this origin, never to Dash0 directly.** `/otlp/v1/traces` and
 * `/otlp/v1/logs` are forwarded by `bench/fixtures/server.mjs`, which holds the auth token. A
 * browser exporter pointed at Dash0's ingress would need that token in page script, where it is
 * readable by every extension and every other script on the page — and this repo already has a
 * whole service-worker broker (`src/sw/broker.ts`) built on the premise that a Dash0 token does
 * not belong in the page. A fixture that contradicted it would be teaching the wrong thing.
 */
import { WebTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";

const TRACER = "d0bar-fixture";

/**
 * One resource for both signals.
 *
 * `service.name` is what groups these in Dash0, and it is deliberately not "d0bar": this is the
 * *host application's* telemetry, the thing d0bar sits beside and must not distort. Naming it
 * after the toolbar would make the fixture's own traffic look like the toolbar's in the very
 * backend used to check that the toolbar sends nothing.
 */
function fixtureResource(serviceName) {
  return resourceFromAttributes({
    "service.name": serviceName,
    "service.version": "0.0.0-fixture",
    "deployment.environment.name": "d0bar-local",
    "telemetry.sdk.language": "webjs",
  });
}

/**
 * Registers the provider with d0bar's processor installed, and a log provider beside it.
 *
 * Called from the page rather than at module scope so the page controls the ordering: the
 * processor has to exist before any span does, and `D0bar` has to have loaded before the
 * processor can be asked for.
 *
 * `export: false` keeps the original behaviour for `/otel.html`, whose specs assert on the join
 * and must not depend on a network destination existing. Only `/try/` turns export on.
 */
export function install(options = {}) {
  const exportTelemetry = options.export === true;
  const serviceName = options.serviceName ?? "northwind-freight-web";
  const resource = fixtureResource(serviceName);

  const spanProcessors = [
    /* At construction. `addSpanProcessor` does not exist on this line — measured, and the
       whole reason `otelSpanProcessor()` is public. */
    globalThis.D0bar.otelSpanProcessor(),
  ];
  if (exportTelemetry) {
    spanProcessors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: "/otlp/v1/traces" }), {
        /* Short, because this is a demo someone is watching. A production page would leave the
           default 5 s — the point of batching is to not wake the radio per span. */
        scheduledDelayMillis: 1500,
      }),
    );
  }

  const provider = new WebTracerProvider({ resource, spanProcessors });
  provider.register();

  let loggerProvider;
  if (exportTelemetry) {
    loggerProvider = new LoggerProvider({
      resource,
      processors: [
        /* One options object, `exporter` inside it — deliberately *not* the
           `BatchSpanProcessor(exporter, config)` shape used two lines above. The two SDKs
           disagree, and passing the trace shape here is silent: the exporter lands in
           `options`, `options.exporter` is undefined, and every record is dropped with no
           error, no warning and an empty queue after `forceFlush()`. Traces exported fine
           throughout, which is what made it look like a network problem. */
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: "/otlp/v1/logs" }),
          scheduledDelayMillis: 1500,
        }),
      ],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
  }

  return { provider, loggerProvider, exporting: exportTelemetry };
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
  const tracer = trace.getTracer(TRACER);
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

/**
 * The `traceparent` header for a span, written by hand.
 *
 * **Without this every row in the panel reads `NONE`, and correctly so.** Tier 2 *reads*
 * `traceparent` off the request (`src/sw/observe.ts`) — it never injects one, because injecting
 * would mean d0bar modifying the traffic it reports on. Trace context reaches the wire only if
 * the application's propagator puts it there, and this fixture installs no
 * `@opentelemetry/instrumentation-fetch`: that patches `fetch`, and a fixture that patched
 * `fetch` could not be used to demonstrate that d0bar does not.
 *
 * So the propagation is written out, which is also what makes it *visible* — a reader can see
 * exactly what a real SDK's propagator would have added, and that d0bar only reads it.
 *
 * `01` as the flags byte: sampled. `00` would be a legal traceparent that says "do not record",
 * which is a different demo.
 */
function traceparentFor(span) {
  const ctx = span.spanContext();
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/** A log record at the given severity, correlated to whatever span is current. */
export function log(severity, body, attributes = {}) {
  /* `logs.getLogger` on the global provider. If `install({ export: true })` was not called the
     global provider is the API's no-op, so this is inert rather than an error — the same shape
     as every other absence in this repo. */
  logs.getLogger(TRACER).emit({
    severityNumber: SeverityNumber[severity] ?? SeverityNumber.INFO,
    severityText: severity,
    body,
    attributes,
  });
}

/**
 * A plausible browsing session: nested spans, real requests, one failure, logs throughout.
 *
 * Fake in the sense that no human did it, real in every other sense — the spans wrap actual
 * `fetch` calls against the fixture's own routes, so tier 1 records resource entries for them
 * and tier 4 has something to join against. A generator that emitted spans without traffic
 * would look right in Dash0 and prove nothing about d0bar.
 *
 * The failure arm is not decoration. A trace where everything succeeds exercises neither the
 * error status nor the untraced-and-failed row in the panel, and both are what someone opens a
 * toolbar to find.
 */
export async function fakeSession(options = {}) {
  const tracer = trace.getTracer(TRACER);
  const checkout = tracer.startSpan("checkout", {
    attributes: { "session.id": options.sessionId ?? String(Date.now()) },
  });

  await context.with(trace.setSpan(context.active(), checkout), async () => {
    log("INFO", "checkout started", { "app.step": "begin" });

    const steps = [
      { name: "load cart", url: "/api/cart?delay=40" },
      { name: "price quote", url: "/api/quote?delay=120" },
      { name: "tax", url: "/api/tax?delay=60" },
      { name: "reserve stock", url: "/api/reserve?delay=90" },
    ];

    for (const step of steps) {
      const span = tracer.startSpan(step.name, { attributes: { "url.full": step.url } });
      await context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const response = await fetch(step.url, {
            headers: { traceparent: traceparentFor(span) },
          });
          await response.text();
          span.setAttribute("http.response.status_code", response.status);
          log("DEBUG", `${step.name} ok`, { "http.response.status_code": response.status });
        } finally {
          span.end();
        }
      });
    }

    /* The one that fails. 503 from the fixture's own `?status=` knob, so the request is real
       and the resource entry the panel shows is a real failed one. */
    const failing = tracer.startSpan("charge card", {
      attributes: { "url.full": "/api/charge?delay=200&status=503" },
    });
    await context.with(trace.setSpan(context.active(), failing), async () => {
      try {
        const response = await fetch("/api/charge?delay=200&status=503", {
          headers: { traceparent: traceparentFor(failing) },
        });
        await response.text();
        failing.setAttribute("http.response.status_code", response.status);
        if (!response.ok) {
          failing.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
          log("ERROR", "payment declined by upstream", {
            "http.response.status_code": response.status,
            "error.type": "upstream_unavailable",
          });
        }
      } catch (error) {
        failing.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        log("ERROR", "payment request threw", { "error.type": String(error) });
      } finally {
        failing.end();
      }
    });

    log("WARN", "checkout finished with one failed step", { "app.step": "end" });
  });

  checkout.end();
  return checkout.spanContext().traceId;
}
