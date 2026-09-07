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
import { trace, SpanStatusCode, ROOT_CONTEXT } from "@opentelemetry/api";

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

/**
 * ## Context is threaded by hand, and that is the whole point of this section
 *
 * `@opentelemetry/sdk-trace-web` installs `StackContextManager` by default, and it **does not
 * survive an `await`**. `context.with(ctx, async () => { … })` sets the context for the
 * synchronous prologue of the callback and nothing after its first suspension point, so the
 * ambient-context style that works under Node's `AsyncLocalStorage` silently produces a new
 * root span — and a new *trace id* — for every step after the first.
 *
 * Measured, not reasoned about. Nine requests from one `checkout` click, read back out of the
 * service worker's own log:
 *
 * ```
 *   root printed by the page   acfa2450…      ← matched nothing
 *   /api/session               faf9888a…
 *   /api/cart                  17be5b87…
 *   /api/quote                 31a9ca37…  ┐
 *   /api/tax                   31a9ca37…  ├─ shared: created in one synchronous tick
 *   /api/promo                 31a9ca37…  ┘
 *   /api/reserve               44cf852d…
 *   /api/charge                793d7f11…
 *   /api/charge (retry)        13aa0822…
 *   /api/notify                c56cccc5…
 * ```
 *
 * Seven traces where there should have been one. The old `fakeSession` had the same defect —
 * it awaited inside a loop — but with one level of nesting it was easy to miss.
 *
 * The fix is **not** `@opentelemetry/context-zone`: that needs `zone.js`, which monkey-patches
 * every async primitive in the page. A fixture whose job is to demonstrate that d0bar patches
 * nothing cannot load a library that patches everything. So every helper below takes its parent
 * `Context` as an argument and passes it to `startSpan` explicitly, which is exactly what the
 * spec's third parameter is for. Nothing here reads `context.active()`.
 */

/** A log record at the given severity, correlated to `ctx` — passed, never ambient. */
export function log(severity, body, attributes = {}, ctx = ROOT_CONTEXT) {
  /* `logs.getLogger` on the global provider. If `install({ export: true })` was not called the
     global provider is the API's no-op, so this is inert rather than an error — the same shape
     as every other absence in this repo. */
  logs.getLogger(TRACER).emit({
    severityNumber: SeverityNumber[severity] ?? SeverityNumber.INFO,
    severityText: severity,
    body,
    attributes,
    /* Explicit, for the reason above: with `StackContextManager` a log emitted after an `await`
       would otherwise correlate to nothing, and a log record with no trace id is the one thing
       a developer cannot use. */
    context: ctx,
  });
}

/**
 * The header that opts a request into server-side spans.
 *
 * Only the scenarios below send it. `bench/fixtures/server.mjs` emits a SERVER span and the
 * database, cache and downstream work beneath it *only* for requests carrying this — every
 * measured arm fetches the same `/api/` routes, and building a payload behind a request whose
 * timing is the subject would make the fixture part of what it measures.
 */
const DEMO = { "x-d0bar-demo": "1" };

/**
 * One instrumented request, as a child of `parent`.
 *
 * `traceparent` is written by hand for the reason in {@link traceparentFor} — no
 * `instrumentation-fetch`, because a fixture that patched `fetch` could not demonstrate that
 * d0bar does not.
 *
 * The response body is read, always. A `fetch` whose body is never consumed produces no
 * `PerformanceResourceTiming` entry in Chromium — measured, not recalled — so tier 1 would see
 * nothing and tier 4 would have nothing to join against.
 */
async function step(name, url, parent, options = {}) {
  const span = trace.getTracer(TRACER).startSpan(
    name,
    {
      attributes: {
        "url.full": url,
        "http.request.method": "GET",
        ...options.attributes,
      },
    },
    parent,
  );

  try {
    const response = await fetch(url, {
      headers: { traceparent: traceparentFor(span), ...DEMO },
    });
    await response.text();
    span.setAttribute("http.response.status_code", response.status);
    if (!response.ok) {
      span.setAttribute("error.type", String(response.status));
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
    }
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
    span.setAttribute("error.type", "fetch_failed");
    throw error;
  } finally {
    span.end();
  }
}

/**
 * An intermediate span. `body(span, ctx)` receives the context to parent its own children to.
 *
 * The second argument is the load-bearing one: a caller that ignores it and relies on ambient
 * context gets a new trace, silently.
 */
async function group(name, attributes, parent, body) {
  const span = trace.getTracer(TRACER).startSpan(name, { attributes }, parent);
  const ctx = trace.setSpan(parent, span);
  try {
    return await body(span, ctx);
  } finally {
    span.end();
  }
}

/** A scenario's root span. Returns the **trace id**, which is what the page prints. */
async function journey(name, attributes, body) {
  /* `ROOT_CONTEXT` explicitly, so a scenario is a root even if something left a stale span in
     the ambient context — which, given the manager above, is a real possibility. */
  const span = trace.getTracer(TRACER).startSpan(name, { attributes }, ROOT_CONTEXT);
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  try {
    await body(span, ctx);
  } finally {
    span.end();
  }
  return span.spanContext().traceId;
}

/**
 * The scenarios `/try/` can run.
 *
 * Each one exists to put a different *shape* in the waterfall, because a panel that only ever
 * renders one shape demonstrates nothing about the panel:
 *
 * ```
 *   checkout  ──▶ deep, with a parallel fan-out and a failure that retries and succeeds
 *   search    ──▶ wide: eight siblings starting together, one slow, one 404
 *   cascade   ──▶ a failure that propagates up three levels and is not recovered
 *   cold      ──▶ a long serial chain — the shape that makes a waterfall worth reading
 * ```
 *
 * All of it is real traffic against the fixture's own routes: the spans wrap actual `fetch`
 * calls, so tier 1 records resource entries and tier 4 has something to join against. A
 * generator that emitted spans without traffic would look right in Dash0 and prove nothing.
 */
export const SCENARIOS = {
  /**
   * A checkout, deep and with one recovered failure.
   *
   * The three pricing calls start together on purpose. Sequential children make a staircase,
   * which is the one shape a waterfall does not need to exist to show; overlapping bars are.
   */
  async checkout() {
    const orderId = `NW-${Math.floor(Math.random() * 90000 + 10000)}`;
    return journey(
      "checkout",
      {
        "session.id": String(Date.now()),
        "enduser.id": "u_20481",
        "order.id": orderId,
        "order.item_count": 4,
        "order.total": 284.5,
      },
      async (root, ctx) => {
        log("INFO", "checkout started", { "order.id": orderId, "app.step": "begin" }, ctx);

        await step("auth.verify-session", "/api/session?delay=25", ctx);

        await group("cart", { "cart.id": "c_9931" }, ctx, async (span, cartCtx) => {
          await step("cart.load", "/api/cart?delay=40", cartCtx);
          log("DEBUG", "cart loaded", { "cart.line_items": 4 }, cartCtx);
        });

        /* The fan-out. `allSettled`, not `all`: one of the three fails and the scenario has to
           continue, which is also what a real checkout does with an unavailable promo service. */
        await group(
          "pricing",
          { "pricing.strategy": "zone-based" },
          ctx,
          async (span, priceCtx) => {
            span.addEvent("fan-out", { "pricing.calls": 3 });
            const results = await Promise.allSettled([
              step("pricing.quote", "/api/quote?delay=140", priceCtx),
              step("pricing.tax", "/api/tax?delay=90", priceCtx),
              step("pricing.promo", "/api/promo?delay=60&status=404", priceCtx),
            ]);
            const failed = results.filter(
              (entry) => entry.status === "rejected" || !entry.value?.ok,
            ).length;
            span.setAttribute("pricing.failed_calls", failed);
            if (failed > 0) {
              log(
                "WARN",
                "promo service unavailable, pricing without discounts",
                { "error.type": "404", "pricing.failed_calls": failed },
                priceCtx,
              );
            }
          },
        );

        await group("inventory", { "warehouse.id": "wh-ams-2" }, ctx, async (span, invCtx) => {
          await step("inventory.reserve", "/api/reserve?delay=110", invCtx);
          log("INFO", "stock reserved", { "warehouse.id": "wh-ams-2" }, invCtx);
        });

        /* The failure, and its recovery. A trace where everything succeeds exercises neither the
           error status nor the retry, and the retry is the more interesting of the two: it is
           the only shape that shows a span erroring beside a sibling that did not. */
        await group(
          "payment",
          { "payment.method": "card", "payment.amount": 284.5 },
          ctx,
          async (span, payCtx) => {
            const first = await step(
              "payment.charge",
              "/api/charge?delay=200&status=503",
              payCtx,
              {
                attributes: { "payment.attempt": 1 },
              },
            );
            if (!first.ok) {
              span.addEvent("retry", { "payment.attempt": 2, "retry.after_ms": 120 });
              log(
                "ERROR",
                "payment declined by upstream, retrying",
                {
                  "http.response.status_code": first.status,
                  "error.type": "upstream_unavailable",
                  "payment.attempt": 1,
                },
                payCtx,
              );
              const second = await step(
                "payment.charge.retry",
                "/api/charge?delay=90",
                payCtx,
                {
                  attributes: { "payment.attempt": 2 },
                },
              );
              span.setAttribute("payment.attempts", 2);
              if (second.ok) {
                log("INFO", "payment captured on retry", { "payment.attempt": 2 }, payCtx);
              }
            }
          },
        );

        await step("notify.confirmation", "/api/notify?delay=45", ctx);
        log("INFO", "checkout complete", { "order.id": orderId, "app.step": "end" }, ctx);
        root.addEvent("order.placed", { "order.id": orderId });
      },
    );
  },

  /**
   * A wide fan-out: eight siblings, started together.
   *
   * The shape that breaks naive waterfalls — every bar starts at the same offset, so depth tells
   * you nothing and only the durations do. One is deliberately five times slower than the rest,
   * which is the thing a developer is actually looking for.
   */
  async search() {
    return journey(
      "search",
      { "search.query": "insulated pallet cover", "search.filters": 3 },
      async (span, ctx) => {
        span.addEvent("fan-out", { "search.shards": 8 });
        log("INFO", "search dispatched", { "search.shards": 8 }, ctx);

        const shards = [40, 55, 38, 62, 480, 44, 51, 47];
        const results = await Promise.allSettled(
          shards.map((delay, index) =>
            step(`search.shard-${index}`, `/api/search?delay=${delay}&shard=${index}`, ctx, {
              attributes: { "search.shard": index },
            }),
          ),
        );

        /* Named in a log because a slow shard is invisible in an aggregate — the p95 of eight
           parallel calls is the slowest one, and the waterfall is where you find out which. */
        const slowest = shards.indexOf(Math.max(...shards));
        log(
          "WARN",
          `shard ${slowest} dominated the response`,
          { "search.shard": slowest, "search.shard_duration_ms": shards[slowest] },
          ctx,
        );
        span.setAttribute("search.results", results.length * 12);
        await step("search.rank", "/api/rank?delay=35", ctx);
      },
    );
  },

  /**
   * A failure that is not recovered, three levels down.
   *
   * The point is the propagation: the leaf 500s, and every ancestor is marked ERROR on the way
   * back up. It is the trace someone opens after seeing one red row in the requests list, and it
   * has to explain the row rather than restate it.
   */
  async cascade() {
    return journey("render-dashboard", { "page.route": "/dashboard" }, async (root, ctx) => {
      log("INFO", "dashboard requested", { "page.route": "/dashboard" }, ctx);
      await step("dashboard.layout", "/api/layout?delay=30", ctx);

      try {
        await group(
          "widget.shipments",
          { "widget.id": "shipments" },
          ctx,
          async (widget, wCtx) => {
            await step("shipments.summary", "/api/shipments?delay=50", wCtx);
            await group(
              "shipments.detail",
              { "widget.tier": "detail" },
              wCtx,
              async (detail, dCtx) => {
                const response = await step(
                  "shipments.detail.fetch",
                  "/api/shipments/detail?delay=160&status=500",
                  dCtx,
                );
                if (!response.ok) {
                  log(
                    "ERROR",
                    "shipment detail query failed",
                    {
                      "http.response.status_code": response.status,
                      "error.type": "internal_error",
                      "widget.id": "shipments",
                    },
                    dCtx,
                  );
                  detail.setStatus({ code: SpanStatusCode.ERROR, message: "HTTP 500" });
                  throw new Error("shipments detail unavailable");
                }
              },
            );
            widget.setStatus({ code: SpanStatusCode.ERROR, message: "child failed" });
          },
        );
      } catch (error) {
        /* Caught at the top so the page keeps working, and recorded so the trace does not read
           as a success. A swallowed error that leaves every span green is the exact thing a
           developer opens a toolbar to stop happening. */
        root.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        root.addEvent("exception", {
          "exception.type": "WidgetRenderError",
          "exception.message": String(error),
        });
        log("ERROR", "dashboard rendered degraded", { "error.type": "WidgetRenderError" }, ctx);
      }

      /* Still runs. The rest of the page loaded, which is why the root is ERROR and not dead. */
      await step("widget.invoices", "/api/invoices?delay=70", ctx);
      log("WARN", "dashboard complete with 1 of 2 widgets", { "widget.failed": 1 }, ctx);
    });
  },

  /**
   * A long serial chain — a cold start with nothing cached.
   *
   * Eleven spans, each waiting on the last. This is the shape where a waterfall earns its keep:
   * the total is the sum, no bar overlaps another, and the only question worth asking is which
   * link to break.
   */
  async cold() {
    return journey("cold-start", { "cache.warm": false }, async (span, ctx) => {
      log("INFO", "cold start, no cached config", { "cache.warm": false }, ctx);
      const chain = [
        ["config.fetch", "/api/config?delay=55"],
        ["config.validate", "/api/validate?delay=30"],
        ["tenant.resolve", "/api/tenant?delay=45"],
        ["features.load", "/api/features?delay=40"],
        ["catalog.index", "/api/catalog?delay=95"],
        ["catalog.warm", "/api/warm?delay=70"],
        ["rates.preload", "/api/quote?delay=85"],
        ["zones.preload", "/api/zones?delay=60"],
        ["session.create", "/api/session?delay=35"],
        ["prefs.load", "/api/prefs?delay=40"],
        ["ready", "/api/ready?delay=25"],
      ];
      for (const [name, url] of chain) await step(name, url, ctx);
      span.addEvent("warm", { "cache.warm": true });
      log("INFO", "cold start finished", { "chain.length": chain.length }, ctx);
    });
  },
};

/**
 * Runs one named scenario and returns its trace id.
 *
 * Kept as the single entry point the page calls so the buttons stay dumb — a button names a
 * scenario, and everything about what that scenario *is* lives above.
 */
export async function runScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`d0bar fixture: no scenario named ${name}`);
  return scenario();
}

/**
 * The original single-journey export, kept as an alias.
 *
 * `otel.spec.ts` and the `/try/` page both referred to `fakeSession`, and renaming it would
 * break a spec for a reason that has nothing to do with what the spec asserts.
 */
export async function fakeSession() {
  return SCENARIOS.checkout();
}
