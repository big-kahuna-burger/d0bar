/**
 * Generates the seven-row trace from design_handoff_d0bar/README.md §7a.
 *
 * This fixture is intentionally small and readable. The 4000-span fixture measures the worker;
 * this one pins visual parity with the handoff: the same span names, services, durations and three
 * correlated logs. Timestamps are protojson strings, matching the API rather than JavaScript's
 * lossy representation of 64-bit nanoseconds.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bench",
  "fixtures",
  "trace-small.json",
);

const MS = 1_000_000n;
const T0 = 1_770_000_000_000n * MS;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const WEB = "0000000000000001";

const spans = [
  ["0000000000000002", "", "HTTP GET /api/shipments", "edge-gateway", 16, 396],
  ["0000000000000003", "0000000000000002", "GET /shipments", "shipments-api", 37, 340],
  ["0000000000000004", "0000000000000003", "SELECT shipments", "postgres", 58, 137],
  ["0000000000000005", "0000000000000003", "GET /rates/{corridor}", "pricing-svc", 198, 155],
  ["0000000000000006", "0000000000000005", "GET rate:eu:nl-de", "redis", 214, 3],
  ["0000000000000007", "0000000000000005", "SELECT tariffs", "postgres", 247, 94],
];

const groups = new Map();
for (const span of spans) {
  const service = span[3];
  const group = groups.get(service);
  if (group) group.push(span);
  else groups.set(service, [span]);
}

const payload = {
  resourceSpans: [...groups].map(([service, group]) => ({
    resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
    scopeSpans: [
      {
        spans: group.map(([spanId, parentSpanId, name, , startMs, durationMs]) => ({
          traceId: TRACE_ID,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          startTimeUnixNano: (T0 + BigInt(startMs) * MS).toString(),
          endTimeUnixNano: (T0 + BigInt(startMs + durationMs) * MS).toString(),
        })),
      },
    ],
  })),
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "pricing-svc" } }],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: (T0 + 220n * MS).toString(),
              severityNumber: 13,
              severityText: "WARN",
              body: {
                stringValue:
                  "tariff cache miss for corridor NL-DE, falling back to pricing-svc",
              },
              traceId: TRACE_ID,
              spanId: "0000000000000005",
            },
            {
              timeUnixNano: (T0 + 250n * MS).toString(),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "loading tariffs from postgres" },
              traceId: TRACE_ID,
              spanId: "0000000000000007",
            },
            {
              timeUnixNano: (T0 + 344n * MS).toString(),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "rate resolved for corridor NL-DE" },
              traceId: TRACE_ID,
              spanId: "0000000000000005",
            },
          ],
        },
      ],
    },
  ],
  webEvents: [
    {
      spanId: WEB,
      name: "GET /shipments/8821",
      origin: "browser · webEvent",
      startTimeUnixNano: T0.toString(),
      endTimeUnixNano: (T0 + 412n * MS).toString(),
    },
  ],
};

await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
