import { describe, expect, it } from "vitest";
import {
  ATTR_CAP,
  F_HAS_LOG,
  LAYOUT_PROTOCOL_VERSION,
  layoutViews,
  type LayoutRequest,
  type LogRecord,
} from "../../src/shared/protocol";
import { layout, type LayoutOk, type LayoutOptions } from "../../src/worker/layout";

/**
 * Correlated log records: how they are read, which survive the cap, and which span each names.
 *
 * Split from `layout.test.ts` because the subject is different — that file is about *rows*, and
 * every case here is about a record's own reading. Two things are asserted that the previous
 * implementation could not have satisfied at all:
 *
 * - a non-string body is **named**, not blanked. The old reader was
 *   `typeof body?.stringValue === "string" ? … : ""`, so a `kvlistValue` body rendered as a level,
 *   a time and nothing — an empty log line rather than a body this panel does not render.
 * - `span-capped` is distinguished from `span-not-in-trace`. This is the only place in the system
 *   where they *can* be distinguished, and reporting the first as the second is a confident claim
 *   about the reader's own trace that happens to be false.
 */

const MS = 1_000_000;
const T0 = 1_700_000_000_000 * MS;

interface SpanSpec {
  id: string;
  start?: number;
  duration?: number;
}

interface LogSpec {
  severity?: number;
  level?: string;
  body?: unknown;
  /** Milliseconds relative to `T0`; may be negative, which is the clock-skew case. */
  at?: number;
  spanId?: string;
  attributes?: unknown[];
  /** Set to omit `body` entirely rather than send a value. */
  noBody?: boolean;
}

/** One `resourceSpans` group and one `resourceLogs` group — the shape the API sends. */
function payload(spans: SpanSpec[], logs: LogSpec[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "edge" } }] },
        scopeSpans: [
          {
            spans: spans.map((spec) => {
              const start = T0 + (spec.start ?? 0) * MS;
              return {
                spanId: spec.id,
                name: spec.id,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + (spec.duration ?? 10) * MS),
              };
            }),
          },
        ],
      },
    ],
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: logs.map((spec) => ({
              severityNumber: spec.severity ?? 9,
              severityText: spec.level ?? "INFO",
              ...(spec.noBody ? {} : { body: spec.body ?? { stringValue: "hello" } }),
              timeUnixNano: String(T0 + (spec.at ?? 0) * MS),
              ...(spec.spanId === undefined ? {} : { spanId: spec.spanId }),
              ...(spec.attributes === undefined ? {} : { attributes: spec.attributes }),
            })),
          },
        ],
      },
    ],
  });
}

function ok(spans: SpanSpec[], logs: LogSpec[], options: LayoutOptions = {}): LayoutOk {
  const request: LayoutRequest = {
    kind: "layout",
    version: LAYOUT_PROTOCOL_VERSION,
    id: 1,
    body: payload(spans, logs),
    from: T0 / MS,
    to: T0 / MS + 1000,
  };
  const result = layout(request, options);
  if (!result.ok) throw new Error(`layout failed: ${result.reason}`);
  return result;
}

/** The one record a single-log fixture produced. */
function only(spans: SpanSpec[], log: LogSpec, options: LayoutOptions = {}): LogRecord {
  const logs = ok(spans, [log], options).logs;
  expect(logs).toHaveLength(1);
  return logs[0]!;
}

describe("body kinds", () => {
  it("renders a string body as its text", () => {
    const log = only([{ id: "root" }], { body: { stringValue: "tariff lookup failed" } });
    expect([log.body, log.bodyKind]).toEqual(["tariff lookup failed", "string"]);
  });

  it("renders numbers and booleans as text, because a number is readable", () => {
    /* protojson writes int64 as a *string* and double/bool as JSON values; both accepted. */
    expect(only([{ id: "root" }], { body: { intValue: "42" } })).toMatchObject({
      body: "42",
      bodyKind: "int",
    });
    expect(only([{ id: "root" }], { body: { doubleValue: 1.5 } })).toMatchObject({
      body: "1.5",
      bodyKind: "double",
    });
    expect(only([{ id: "root" }], { body: { boolValue: false } })).toMatchObject({
      body: "false",
      bodyKind: "bool",
    });
  });

  it("names a container body instead of blanking it", () => {
    /* The assertion the old `: ""` reader would fail: each of these rendered as an empty log line,
       indistinguishable from a record whose body genuinely was "". */
    for (const [value, kind] of [
      [{ arrayValue: { values: [] } }, "array"],
      [{ kvlistValue: { values: [] } }, "kvlist"],
      [{ bytesValue: "AAEC" }, "bytes"],
    ] as const) {
      const log = only([{ id: "root" }], { body: value });
      expect([log.body, log.bodyKind]).toEqual(["", kind]);
    }
  });

  it("reads an absent body as absent, not as an empty string", () => {
    const log = only([{ id: "root" }], { noBody: true });
    expect([log.body, log.bodyKind]).toEqual(["", "absent"]);
  });

  it("falls back to LOG when the emitter set no severity text", () => {
    const request = JSON.parse(payload([{ id: "root" }], [{}])) as {
      resourceLogs: [{ scopeLogs: [{ logRecords: [Record<string, unknown>] }] }];
    };
    delete request.resourceLogs[0].scopeLogs[0].logRecords[0]["severityText"];
    delete request.resourceLogs[0].scopeLogs[0].logRecords[0]["severityNumber"];
    const result = layout({
      kind: "layout",
      version: LAYOUT_PROTOCOL_VERSION,
      id: 1,
      body: JSON.stringify(request),
      from: T0 / MS,
      to: T0 / MS + 1000,
    });
    if (!result.ok) throw new Error(result.reason);
    /* `0`, not `1`: a record whose emitter set no severity is not an implicit TRACE, and the
       severity band renders it as "none" rather than as the least severe real level. */
    expect(result.logs[0]).toMatchObject({ level: "LOG", severity: 0 });
  });
});

describe("attachment", () => {
  it("resolves a span id to its row and marks the row", () => {
    const result = ok([{ id: "root" }, { id: "child" }], [{ spanId: "child" }]);
    const log = result.logs[0]!;
    expect(log.row).toBe(1);
    expect(log.unattached).toBe(0);

    const views = layoutViews(result.buffer, result.count);
    expect(views.flags[1]! & F_HAS_LOG).toBe(F_HAS_LOG);
    /* Only the row a record names. A flag set on every row would make the ◆ marker meaningless. */
    expect(views.flags[0]! & F_HAS_LOG).toBe(0);
  });

  it("reads a record with no span id as trace-level", () => {
    const log = only([{ id: "root" }], {});
    expect([log.row, log.unattached]).toEqual([-1, "no-span-id"]);
  });

  it("reads an id absent from the payload as not in the trace", () => {
    const log = only([{ id: "root" }], { spanId: "elsewhere" });
    expect([log.row, log.unattached]).toEqual([-1, "span-not-in-trace"]);
  });

  it("distinguishes a span the row cap dropped from one the trace never held", () => {
    /* The case this enum exists for. Both records fail to resolve a row; only one of them names a
       span that is genuinely absent, and calling the other "not in this trace" would be false. */
    const result = ok(
      [{ id: "root" }, { id: "kept", start: 1 }, { id: "dropped", start: 2 }],
      [{ spanId: "dropped" }, { spanId: "never-sent" }],
      { cap: 2 },
    );
    expect(result.count).toBe(2);
    expect(result.summary.truncated).toBe(true);
    expect(result.logs.map((log) => [log.row, log.unattached])).toEqual([
      [-1, "span-capped"],
      [-1, "span-not-in-trace"],
    ]);
  });
});

describe("the log cap", () => {
  it("keeps the severest even when it arrives last", () => {
    /* Capped by *severity*, not arrival. The footer derives its worst-of from this list, so a cap
       that dropped by arrival could drop the severest and leave the footer naming a record absent
       from the list beneath it. */
    const result = ok(
      [{ id: "root" }],
      [
        { severity: 9, level: "INFO", body: { stringValue: "first" } },
        { severity: 5, level: "DEBUG", body: { stringValue: "second" } },
        { severity: 17, level: "ERROR", body: { stringValue: "last" } },
      ],
      { logCap: 2 },
    );
    expect(result.logs.map((log) => log.body)).toEqual(["first", "last"]);
    /* Reported honestly: two shown of three held, which is what makes the "N of M" copy possible. */
    expect(result.logsSeen).toBe(3);
    expect(result.summary.logCount).toBe(3);
  });

  it("returns the survivors in arrival order, not in severity order", () => {
    const result = ok(
      [{ id: "root" }],
      [
        { severity: 17, level: "ERROR", body: { stringValue: "a" }, at: 1 },
        { severity: 9, level: "INFO", body: { stringValue: "b" }, at: 2 },
        { severity: 13, level: "WARN", body: { stringValue: "c" }, at: 3 },
      ],
    );
    expect(result.logs.map((log) => log.body)).toEqual(["a", "b", "c"]);
  });

  it("keeps the earliest record at the worst severity when the cap forces a choice", () => {
    /* The tie-break the footer's "worst" depends on: the earliest at the worst severity is the one
       that explains the others, so it must be the one the cap keeps. */
    const result = ok(
      [{ id: "root" }],
      [
        { severity: 17, level: "ERROR", body: { stringValue: "earliest error" }, at: 1 },
        { severity: 17, level: "ERROR", body: { stringValue: "later error" }, at: 2 },
      ],
      { logCap: 1 },
    );
    expect(result.logs.map((log) => log.body)).toEqual(["earliest error"]);
  });
});

describe("offsets", () => {
  it("measures from the trace's own start", () => {
    const log = only([{ id: "root", start: 10, duration: 100 }], { at: 35 });
    /* The bound, not exactness — the same considered loss `nanos()` documents. A double's spacing
       at a 2026 epoch is 256 ns, and both endpoints round at parse time, so the difference carries
       up to 256 ns of error. Observed here: 25 000 192 against 25 000 000. */
    expect(Math.abs(log.offsetNs - 25 * MS)).toBeLessThanOrEqual(256);
    /* The absolute time is carried too — `offsetNs` cannot be un-subtracted, and the wall clock is
       what a reader pastes into a log search. */
    expect(log.timeNs).toBe(T0 + 35 * MS);
  });

  it("clamps at zero rather than rendering a negative offset", () => {
    /* A record stamped before the trace's earliest span is real: two services' clocks disagree.
       Clamped, not dropped and not shown as negative — the absolute timestamp still tells the
       truth about when it was emitted. */
    const log = only([{ id: "root", start: 50 }], { at: 20 });
    expect(log.offsetNs).toBe(0);
    expect(log.timeNs).toBe(T0 + 20 * MS);
  });
});

describe("attributes", () => {
  it("reads each value through the same kind logic as a body", () => {
    const log = only([{ id: "root" }], {
      attributes: [
        { key: "http.method", value: { stringValue: "GET" } },
        { key: "http.status_code", value: { intValue: "503" } },
        { key: "retry", value: { boolValue: true } },
        { key: "corridor", value: { kvlistValue: { values: [] } } },
        { key: "keyless" },
      ],
    });
    expect(log.attrs).toEqual([
      { key: "http.method", value: "GET", kind: "string" },
      { key: "http.status_code", value: "503", kind: "int" },
      { key: "retry", value: "true", kind: "bool" },
      { key: "corridor", value: "", kind: "kvlist" },
      /* A key with no value is kept: the key is the whole identity of an attribute, and dropping
         it would hide that the emitter set it at all. */
      { key: "keyless", value: "", kind: "absent" },
    ]);
    expect(log.attrsSeen).toBe(5);
  });

  it("drops an entry with no key, which cannot be rendered as anything", () => {
    const log = only([{ id: "root" }], {
      attributes: [{ value: { stringValue: "orphan" } }, { key: "kept", value: {} }],
    });
    expect(log.attrs.map((attr) => attr.key)).toEqual(["kept"]);
  });

  it("truncates past the cap and reports how many the record held", () => {
    const log = only(
      [{ id: "root" }],
      {
        attributes: Array.from({ length: 6 }, (_, i) => ({
          key: `k${i}`,
          value: { stringValue: String(i) },
        })),
      },
      { attrCap: 3 },
    );
    expect(log.attrs.map((attr) => attr.key)).toEqual(["k0", "k1", "k2"]);
    /* Both numbers, so the view can say "showing 3 of 6" rather than presenting its own choice as
       a count of what the record has. */
    expect(log.attrsSeen).toBe(6);
  });

  it("reports no attributes as zero, not as a truncation", () => {
    const log = only([{ id: "root" }], {});
    expect(log.attrs).toEqual([]);
    expect(log.attrsSeen).toBe(0);
    expect(ATTR_CAP).toBeGreaterThan(0);
  });
});

describe("payload shapes", () => {
  it("reads the pre-0.16 instrumentationLibraryLogs group too", () => {
    const result = layout({
      kind: "layout",
      version: LAYOUT_PROTOCOL_VERSION,
      id: 1,
      body: JSON.stringify({
        resourceSpans: JSON.parse(payload([{ id: "root" }], []))["resourceSpans"],
        resourceLogs: [
          {
            instrumentationLibraryLogs: [
              {
                logRecords: [
                  { severityNumber: 13, severityText: "WARN", body: { stringValue: "legacy" } },
                ],
              },
            ],
          },
        ],
      }),
      from: T0 / MS,
      to: T0 / MS + 1000,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.logs.map((log) => log.body)).toEqual(["legacy"]);
  });

  it("returns no logs for a payload with no resourceLogs at all", () => {
    const result = ok([{ id: "root" }], []);
    expect(result.logs).toEqual([]);
    expect(result.logsSeen).toBe(0);
    expect(result.summary.logCount).toBe(0);
    const views = layoutViews(result.buffer, result.count);
    expect(views.flags[0]! & F_HAS_LOG).toBe(0);
  });
});
