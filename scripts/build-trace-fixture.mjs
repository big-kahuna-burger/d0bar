/**
 * Generates `bench/fixtures/trace-4000.json` — the 4000-span trace the layout budget is
 * measured against.
 *
 * **Synthetic, and said so.** `add-perturbation-budget` task 2.2 asks for "a real OTLP trace,
 * 4000 spans, ~40 services, depth >= 12". This is not a captured one: capturing a trace of that
 * size from a live tenant would put a customer's service names, URLs and timings in this
 * repository, which is not a trade worth making for a benchmark input. What is faithful is the
 * *shape*, which is all the layout worker reads:
 *
 *   - protojson encoding, including 64-bit nanosecond timestamps as **strings** — the single
 *     most important detail, because reading them as numbers is where precision is lost
 *   - one `resourceSpans` group per service, each with its own `service.name` resource attribute
 *   - `scopeSpans` (not the pre-0.16 `instrumentationLibrarySpans`), spans in emission order
 *     rather than tree order, so the worker's ordering is actually exercised
 *   - parents nested to depth >= 12, a realistic error rate, and correlated logs
 *
 * Deterministic: a seeded PRNG, so the committed file is reproducible and a diff to it means
 * somebody changed the generator rather than that it ran again.
 *
 * Run with `pnpm fixture:trace`.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bench",
  "fixtures",
  "trace-4000.json",
);

const SPANS = 4000;
const SERVICES = 40;
const MIN_DEPTH = 12;
/** Trace start, nanoseconds. A 2026 epoch, so the double-precision behaviour is realistic. */
const T0 = 1_770_000_000_000n * 1_000_000n;
/** Whole-trace duration, nanoseconds — 1.8 s, a plausible slow request. */
const TOTAL = 1_800_000_000n;

/** Mulberry32. Seeded, so the committed fixture is reproducible byte for byte. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(0xd0bad0ba);

const pick = (list) => list[Math.floor(random() * list.length) % list.length];

const SERVICE_NAMES = Array.from({ length: SERVICES }, (_, i) => {
  const kinds = ["api", "svc", "worker", "gateway", "store"];
  const domains = [
    "quote",
    "tariff",
    "routing",
    "customs",
    "fleet",
    "billing",
    "identity",
    "notify",
    "pricing",
    "inventory",
    "manifest",
    "customer",
    "audit",
    "geo",
    "rates",
    "docs",
  ];
  return `${domains[i % domains.length]}-${kinds[i % kinds.length]}-${Math.floor(i / domains.length)}`;
});

const OPERATIONS = [
  "GET /v1/quote",
  "POST /v1/book",
  "SELECT shipments",
  "INSERT audit_log",
  "redis.get",
  "kafka.produce",
  "grpc.Lookup",
  "http.client",
  "cache.warm",
  "tariff.resolve",
  "route.plan",
  "customs.classify",
  "fx.convert",
  "pdf.render",
];

let spanCounter = 0;
const hex = (n) => n.toString(16).padStart(16, "0");
const nextId = () => hex(++spanCounter * 0x9e3779b1);

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

/**
 * Builds the tree.
 *
 * A spine of {@link MIN_DEPTH}+2 spans guarantees the depth requirement outright rather than
 * hoping the random fan-out reaches it; everything else hangs off a random existing node, which
 * is what produces the ragged shape a real trace has.
 */
const spans = [];
const root = {
  id: nextId(),
  parent: "",
  service: SERVICE_NAMES[0],
  name: "GET /api/quote",
  start: T0,
  end: T0 + TOTAL,
  depth: 0,
  error: false,
};
spans.push(root);

let spine = root;
for (let d = 1; d <= MIN_DEPTH + 2; d += 1) {
  const start = spine.start + (spine.end - spine.start) / 20n;
  const end = spine.end - (spine.end - spine.start) / 20n;
  spine = {
    id: nextId(),
    parent: spine.id,
    service: SERVICE_NAMES[d % SERVICES],
    name: pick(OPERATIONS),
    start,
    end,
    depth: d,
    error: false,
  };
  spans.push(spine);
}

while (spans.length < SPANS) {
  /* Biased toward recent spans, which is what makes the tree deep and ragged rather than a
     uniform bush — a uniform parent choice produces a tree of depth ~2 with 4000 children. */
  const parent = spans[Math.floor(spans.length * (1 - random() ** 2))] ?? root;
  const room = parent.end - parent.start;
  if (room < 2000n) continue;
  const offset = BigInt(Math.floor(random() * Number(room / 2n)));
  const width = BigInt(Math.max(1, Math.floor(random() * Number(room / 2n))));
  spans.push({
    id: nextId(),
    parent: parent.id,
    service: SERVICE_NAMES[Math.floor(random() * SERVICES)],
    name: pick(OPERATIONS),
    start: parent.start + offset,
    end: parent.start + offset + width,
    depth: parent.depth + 1,
    /* Roughly 3%, concentrated nowhere in particular. */
    error: random() < 0.03,
  });
}

/* Emission order, not tree order. A real collector writes spans as they finish, so a worker
   that quietly relied on parents arriving before children would pass against a sorted fixture
   and fail in production. */
const emitted = spans.slice(1).sort(() => random() - 0.5);
emitted.unshift(spans[0]);

const byService = new Map();
for (const span of emitted) {
  const bucket = byService.get(span.service);
  if (bucket) bucket.push(span);
  else byService.set(span.service, [span]);
}

const payload = {
  resourceSpans: [...byService].map(([service, group]) => ({
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: service } },
        { key: "deployment.environment", value: { stringValue: "production" } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: "@opentelemetry/instrumentation-http", version: "0.57.0" },
        spans: group.map((span) => ({
          traceId: TRACE_ID,
          spanId: span.id,
          ...(span.parent ? { parentSpanId: span.parent } : {}),
          name: span.name,
          kind: "SPAN_KIND_SERVER",
          /* Strings. protojson encodes a 64-bit integer as a string because JSON numbers are
             doubles, and this is the detail the worker's `nanos()` exists for. */
          startTimeUnixNano: span.start.toString(),
          endTimeUnixNano: span.end.toString(),
          ...(span.error ? { status: { code: 2, message: "upstream failure" } } : {}),
        })),
      },
    ],
  })),
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAMES[3] } }],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: (T0 + TOTAL / 3n).toString(),
              severityNumber: 13,
              severityText: "WARN",
              body: { stringValue: "tariff cache miss for corridor NL-DE" },
              traceId: TRACE_ID,
            },
            {
              timeUnixNano: (T0 + TOTAL / 2n).toString(),
              severityNumber: 17,
              severityText: "ERROR",
              body: { stringValue: "customs classification timed out after 800ms" },
              traceId: TRACE_ID,
            },
          ],
        },
      ],
    },
  ],
  webEvents: [
    {
      spanId: nextId(),
      name: "GET /api/quote",
      origin: "https://app.example.com",
      startTimeUnixNano: (T0 - 40_000_000n).toString(),
      endTimeUnixNano: (T0 + TOTAL + 12_000_000n).toString(),
    },
  ],
};

const json = JSON.stringify(payload);
await writeFile(OUT, json);

const depth = Math.max(...spans.map((span) => span.depth));
console.log(
  `trace-4000: ${spans.length} spans, ${byService.size} services, max depth ${depth}, ` +
    `${(json.length / 1024).toFixed(0)} kB → ${OUT}`,
);
