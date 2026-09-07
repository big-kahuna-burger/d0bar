/**
 * The `/try/` demo's **server side**: spans for work that happens behind each `/api/` request.
 *
 * ## Why this exists
 *
 * Everything the page emits carries one `service.name`, so every trace d0bar showed was a single
 * service deep and the panel's service count was permanently 1. A browser client span with no
 * server span under it is also the least interesting half of a trace: the whole reason to open a
 * waterfall is to see where the time went, and "somewhere on the server" is not an answer.
 *
 * So the fixture server emits the other half — a SERVER span parented to the browser's client
 * span, and beneath it the database, cache, queue and downstream-service work a real backend
 * would report. The traces are then genuinely distributed: three or four services, five levels
 * deep, with a failure that propagates.
 *
 * ## Why it is not the OpenTelemetry SDK
 *
 * The spans are built as OTLP/JSON by hand. Two reasons, in order of weight:
 *
 *   1. **The timings must be the request's real ones.** The browser already measured this
 *      request; the server span has to sit inside that bar, not next to it. Synthesising the
 *      body from the timestamps the handler already has is exact, where an SDK would time its
 *      own instrumentation of a handler that mostly sleeps.
 *   2. No `@opentelemetry/sdk-node` in the fixture's dependency tree. The ESLint rule bans
 *      `@opentelemetry/*` from `src/**` and the build fails if the string reaches an artifact;
 *      keeping the server side dependency-free keeps that boundary uninteresting to argue about.
 *
 * This is **synthesis, not translation** — and that distinction is the honest line here. The
 * timings, the route, the status and the trace context are all real. The subtree *shape* under
 * the SERVER span is invented: there is no Postgres, and nothing is actually charged. It is
 * labelled as a demo in the resource (`deployment.environment.name: d0bar-local`) so nobody
 * mistakes it for a measurement.
 *
 * ## Why it cannot run during a benchmark
 *
 * `/api/*` is the same handler every measured arm fetches. Emitting spans for those would put a
 * JSON build and an outbound `fetch` behind requests whose timing is the subject — the fixture
 * measuring instead of being measured. So the caller gates this on a header only the demo's own
 * fetches send (`x-d0bar-demo`), and this module is pure: it builds a payload and returns it,
 * doing no I/O and touching no clock of its own.
 */

import { randomBytes } from "node:crypto";

/** OTLP span kinds. Named because `kind: 2` in a literal is unreadable six months later. */
const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };

/** OTLP status codes. `2` is ERROR; `0` is unset, which is what a healthy span carries. */
const STATUS_ERROR = 2;

const API = "northwind-freight-api";
const PAYMENTS = "northwind-payments";
const WAREHOUSE = "northwind-warehouse";

export function spanId() {
  return randomBytes(8).toString("hex");
}

/**
 * The `traceparent` header, or `undefined`.
 *
 * Parsed rather than trusted: a malformed header must not produce a span with a half-valid trace
 * id, because that lands in Dash0 as a trace nobody can find and looks like data loss.
 */
export function parseTraceparent(header) {
  if (typeof header !== "string") return undefined;
  const parts = header.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [version, traceId, parentId, flags] = parts;
  if (version !== "00" || !/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(parentId)) {
    return undefined;
  }
  /* An unsampled parent gets no children. Emitting them anyway would mean the fixture recording
     traffic the application's own propagator said not to record. */
  if (!/^[0-9a-f]{2}$/.test(flags) || (parseInt(flags, 16) & 1) === 0) return undefined;
  return { traceId, parentId };
}

function ns(ms) {
  /* String, not number: nanosecond epoch exceeds 2^53, and OTLP/JSON specifies these as strings
     for exactly that reason. `Math.round` before `BigInt` because `ms` is fractional. */
  return String(BigInt(Math.round(ms * 1e6)));
}

/** `{a: 1, b: "x"}` → OTLP attribute array. Skips `undefined` so callers can pass sparse objects. */
function attrs(object) {
  const out = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") {
      out.push({
        key,
        value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
      });
    } else if (typeof value === "boolean") {
      out.push({ key, value: { boolValue: value } });
    } else {
      out.push({ key, value: { stringValue: String(value) } });
    }
  }
  return out;
}

/**
 * The subtree shape per route.
 *
 * A table rather than a switch: every row is one route's story, and the interesting property of
 * the demo — that different requests look structurally different in the waterfall — is legible
 * here in a way it would not be spread across branches. `at` and `for` are **fractions of the
 * parent's duration**, so a child always nests inside its parent no matter what `?delay=` said.
 */
const SHAPES = {
  "/api/cart": [
    { svc: API, name: "SELECT carts", kind: KIND.CLIENT, at: 0.15, for: 0.5, db: "carts" },
  ],
  "/api/quote": [
    {
      svc: API,
      name: "SELECT rate_cards",
      kind: KIND.CLIENT,
      at: 0.08,
      for: 0.22,
      db: "rate_cards",
    },
    {
      svc: API,
      name: "GET rates.northwind.example",
      kind: KIND.CLIENT,
      at: 0.34,
      for: 0.55,
      peer: "rates.northwind.example",
    },
  ],
  "/api/tax": [
    {
      svc: API,
      name: "GET taxsvc.internal",
      kind: KIND.CLIENT,
      at: 0.1,
      for: 0.8,
      peer: "taxsvc.internal",
    },
  ],
  "/api/promo": [
    /* A cache miss, then the lookup it forced. The point of the pair is that the waterfall shows
     *why* the slow child ran. */
    { svc: API, name: "GET promo:SPRING", kind: KIND.CLIENT, at: 0.05, for: 0.1, cache: true },
    {
      svc: API,
      name: "SELECT promotions",
      kind: KIND.CLIENT,
      at: 0.2,
      for: 0.7,
      db: "promotions",
    },
  ],
  "/api/reserve": [
    {
      svc: API,
      name: "SELECT inventory",
      kind: KIND.CLIENT,
      at: 0.06,
      for: 0.25,
      db: "inventory",
    },
    {
      svc: API,
      name: "UPDATE inventory",
      kind: KIND.CLIENT,
      at: 0.36,
      for: 0.3,
      db: "inventory",
    },
    {
      svc: WAREHOUSE,
      name: "POST /pick-lists",
      kind: KIND.SERVER,
      at: 0.7,
      for: 0.28,
      children: [
        {
          svc: WAREHOUSE,
          name: "INSERT pick_lists",
          kind: KIND.CLIENT,
          at: 0.2,
          for: 0.6,
          db: "pick_lists",
        },
      ],
    },
  ],
  "/api/charge": [
    { svc: API, name: "SELECT orders", kind: KIND.CLIENT, at: 0.04, for: 0.14, db: "orders" },
    {
      svc: PAYMENTS,
      name: "POST /authorizations",
      kind: KIND.SERVER,
      at: 0.22,
      for: 0.74,
      /* The failure lives down here, three services from the click, which is the whole argument
         for opening a trace instead of reading a status code. */
      failing: true,
      children: [
        {
          svc: PAYMENTS,
          name: "POST api.stripe.com/v1/charges",
          kind: KIND.CLIENT,
          at: 0.15,
          for: 0.8,
          peer: "api.stripe.com",
          failing: true,
        },
      ],
    },
  ],
  "/api/notify": [
    {
      svc: API,
      name: "order-events publish",
      kind: KIND.PRODUCER,
      at: 0.2,
      for: 0.6,
      queue: "order-events",
    },
  ],
};

/** Anything not in the table still gets a server span and one query, so no route looks empty. */
const FALLBACK = [
  { svc: API, name: "SELECT 1", kind: KIND.CLIENT, at: 0.2, for: 0.5, db: "pg_catalog" },
];

function childAttrs(node, failed) {
  if (node.db) {
    return attrs({
      "db.system.name": "postgresql",
      "db.namespace": "northwind",
      "db.collection.name": node.db,
      "db.operation.name": node.name.split(" ")[0],
      "db.query.text": `${node.name} WHERE tenant_id = $1`,
      "server.address": "pg-primary.northwind.internal",
      "server.port": 5432,
    });
  }
  if (node.cache) {
    return attrs({
      "db.system.name": "redis",
      "db.operation.name": "GET",
      "cache.hit": false,
      "server.address": "redis-0.northwind.internal",
      "server.port": 6379,
    });
  }
  if (node.queue) {
    return attrs({
      "messaging.system": "kafka",
      "messaging.operation.name": "publish",
      "messaging.destination.name": node.queue,
      "messaging.message.body.size": 412,
    });
  }
  if (node.peer) {
    return attrs({
      "http.request.method": node.name.split(" ")[0],
      "server.address": node.peer,
      "url.full": `https://${node.peer}/`,
      "http.response.status_code": failed ? 502 : 200,
      "error.type": failed ? "502" : undefined,
    });
  }
  return attrs({
    "http.request.method": "POST",
    "http.route": "/" + node.name.split(" ").pop(),
  });
}

function buildNode(node, ctx, failed) {
  const start = ctx.start + ctx.duration * node.at;
  const duration = ctx.duration * node.for;
  const id = spanId();
  const isFailed = Boolean(node.failing && failed);

  const span = {
    traceId: ctx.traceId,
    spanId: id,
    parentSpanId: ctx.parentId,
    name: node.name,
    kind: node.kind,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(start + duration),
    attributes: childAttrs(node, isFailed),
  };
  if (isFailed) {
    span.status = { code: STATUS_ERROR, message: "upstream returned 502" };
    span.events = [
      {
        timeUnixNano: ns(start + duration * 0.85),
        name: "exception",
        attributes: attrs({
          "exception.type": "UpstreamUnavailable",
          "exception.message": "payment processor returned 502",
          "exception.escaped": true,
        }),
      },
    ];
  }

  const spans = [{ service: node.svc, span }];
  for (const child of node.children ?? []) {
    spans.push(
      ...buildNode(child, { traceId: ctx.traceId, parentId: id, start, duration }, failed),
    );
  }
  return spans;
}

/**
 * Builds the OTLP/JSON body for one request's server-side subtree.
 *
 * Pure: no I/O, no `Date.now()`. The caller passes the timestamps it already measured, which is
 * what keeps the server span inside the browser's bar rather than beside it.
 *
 * Returns `undefined` when there is nothing to say — no usable trace context, meaning the page
 * did not propagate one, and inventing a trace id here would fabricate a trace the browser has
 * no span in.
 */
export function backendSpans({ traceparent, method, path, status, startMs, endMs }) {
  const context = parseTraceparent(traceparent);
  if (!context) return undefined;

  const duration = Math.max(1, endMs - startMs);
  const failed = status >= 500;
  const rootId = spanId();

  /* The SERVER span: the request as the backend saw it. Its parent is the browser's client span,
     which is the join that makes the trace distributed rather than two traces. */
  const root = {
    traceId: context.traceId,
    spanId: rootId,
    parentSpanId: context.parentId,
    name: `${method} ${path}`,
    kind: KIND.SERVER,
    startTimeUnixNano: ns(startMs),
    endTimeUnixNano: ns(endMs),
    attributes: attrs({
      "http.request.method": method,
      "http.route": path,
      "url.path": path,
      "url.scheme": "http",
      "server.address": "freight-api.northwind.internal",
      "server.port": 8080,
      "http.response.status_code": status,
      "network.protocol.version": "1.1",
      "error.type": failed ? String(status) : undefined,
    }),
  };
  if (failed) {
    root.status = { code: STATUS_ERROR, message: `HTTP ${status}` };
  }

  const collected = [{ service: API, span: root }];
  for (const node of SHAPES[path] ?? FALLBACK) {
    collected.push(
      ...buildNode(
        node,
        { traceId: context.traceId, parentId: rootId, start: startMs, duration },
        failed,
      ),
    );
  }

  return { resourceSpans: group(collected) };
}

/**
 * Groups spans by service into `resourceSpans`.
 *
 * One resource per service, which is what makes Dash0 treat them as separate services and draw
 * an edge between them. Emitting every span under one resource would produce the same waterfall
 * and a service map with one node — the thing this module exists to fix.
 */
function group(collected) {
  const byService = new Map();
  for (const { service, span } of collected) {
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service).push(span);
  }

  return [...byService].map(([service, spans]) => ({
    resource: {
      attributes: attrs({
        "service.name": service,
        "service.version": "0.0.0-fixture",
        /* Marks the whole subtree as the demo's. These spans are synthesised around real
           timings, and nothing about them should read as production telemetry. */
        "deployment.environment.name": "d0bar-local",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.name": "d0bar-fixture",
      }),
    },
    scopeSpans: [{ scope: { name: "d0bar-fixture-backend" }, spans }],
  }));
}
