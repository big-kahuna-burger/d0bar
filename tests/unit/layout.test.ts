import { describe, expect, it } from "vitest";
import {
  F_CYCLE,
  F_DEGENERATE,
  F_ERROR,
  F_ORPHAN,
  F_ROOT,
  LAYOUT_PROTOCOL_VERSION,
  ROW_BYTES,
  layoutViews,
  type LayoutRequest,
} from "../../src/shared/protocol";
import { layout, toResponse, type LayoutOk } from "../../src/worker/layout";

/**
 * The trace layout, driven entirely through crafted payloads.
 *
 * No worker here on purpose. `layout()` is pure — OTLP text in, positioned rows out — so every
 * decision that matters can be settled by an assertion instead of by looking at a waterfall,
 * and the worker entry is left holding four lines of plumbing that a browser test covers.
 *
 * The cases below are mostly the *broken* traces. That is deliberate: a trace arrives
 * mid-ingest, from a system that was itself partly broken, and those shapes are the normal
 * reason someone opens this panel. Each one has to render and say what is wrong with it.
 */

const MS = 1_000_000;
const T0 = 1_700_000_000_000 * MS;

interface SpanSpec {
  id: string;
  parent?: string;
  name?: string;
  service?: string;
  /** Milliseconds after `T0`. */
  start?: number;
  duration?: number;
  error?: boolean;
}

/** Builds an OTLP payload, one `resourceSpans` group per distinct service. */
function otlp(specs: SpanSpec[], extra: Record<string, unknown> = {}): string {
  const byService = new Map<string, SpanSpec[]>();
  for (const spec of specs) {
    const service = spec.service ?? "edge";
    const bucket = byService.get(service);
    if (bucket) bucket.push(spec);
    else byService.set(service, [spec]);
  }

  return JSON.stringify({
    resourceSpans: [...byService].map(([service, group]) => ({
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [
        {
          spans: group.map((spec) => {
            const start = T0 + (spec.start ?? 0) * MS;
            return {
              spanId: spec.id,
              ...(spec.parent === undefined ? {} : { parentSpanId: spec.parent }),
              name: spec.name ?? spec.id,
              /* Strings, as protojson emits a 64-bit integer — the shape the real API sends. */
              startTimeUnixNano: String(start),
              endTimeUnixNano: String(start + (spec.duration ?? 10) * MS),
              ...(spec.error ? { status: { code: 2 } } : {}),
            };
          }),
        },
      ],
    })),
    ...extra,
  });
}

function request(body: string): LayoutRequest {
  return {
    kind: "layout",
    version: LAYOUT_PROTOCOL_VERSION,
    id: 1,
    body,
    from: T0 / MS - 2000,
    to: T0 / MS + 2000,
  };
}

/** Lays out a payload and fails loudly rather than returning a union the test has to narrow. */
function ok(specs: SpanSpec[], extra: Record<string, unknown> = {}): LayoutOk {
  const result = layout(request(otlp(specs, extra)));
  if (!result.ok) throw new Error(`layout failed: ${result.reason}`);
  return result;
}

/** The rows, as plain objects — for assertions only; nothing in shipped code does this. */
function rows(result: LayoutOk) {
  const views = layoutViews(result.buffer, result.count);
  return Array.from({ length: result.count }, (_, i) => ({
    name: result.strings[views.nameId[i]!],
    service: result.strings[views.serviceId[i]!],
    depth: views.depth[i]!,
    left: views.left[i]!,
    width: views.width[i]!,
    durationNs: views.durationNs[i]!,
    palette: views.paletteIndex[i]!,
    flags: views.flags[i]!,
  }));
}

describe("byte layout", () => {
  it("gives every view its natural alignment", () => {
    /* A `Float64Array` at a non-multiple-of-8 offset throws outright, and the throw would be
       the *only* symptom — there is no wrong-but-plausible version of this. Exercised at odd
       counts, which is where a naive layout misaligns. */
    for (const count of [1, 3, 7, 4000]) {
      const buffer = new ArrayBuffer(count * ROW_BYTES);
      expect(() => layoutViews(buffer, count)).not.toThrow();
      const views = layoutViews(buffer, count);
      expect(views.durationNs).toHaveLength(count);
      expect(views.flags).toHaveLength(count);
    }
  });

  it("packs a row into 27 bytes", () => {
    /* Stated as a number rather than as the sum, so a field added without a version bump
       fails here. 4000 spans is 108 kB — the size that makes transferring worth insisting on. */
    expect(ROW_BYTES).toBe(27);
    expect(4000 * ROW_BYTES).toBe(108_000);
  });
});

describe("layout", () => {
  it("orders rows depth-first, earliest sibling first", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "b", parent: "root", start: 40, duration: 20 },
      { id: "a", parent: "root", start: 10, duration: 20 },
      { id: "a1", parent: "a", start: 12, duration: 5 },
    ]);

    /* The main thread renders this array in index order and never sorts, so the order *is*
       the tree. `a` before `b` because it started earlier; `a1` between them because it is
       `a`'s child. */
    expect(rows(result).map((row) => row.name)).toEqual(["root", "a", "a1", "b"]);
    expect(rows(result).map((row) => row.depth)).toEqual([0, 1, 2, 1]);
  });

  it("positions bars as fractions of the trace's own extent", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "half", parent: "root", start: 50, duration: 50 },
    ]);
    const [root, half] = rows(result);

    expect(root!.left).toBeCloseTo(0, 5);
    expect(root!.width).toBeCloseTo(1, 5);
    expect(half!.left).toBeCloseTo(0.5, 5);
    expect(half!.width).toBeCloseTo(0.5, 5);
    /* Nanoseconds, not milliseconds — the main thread formats, it does not convert.
       Within 256 ns rather than exact, which is the double-precision bound documented on
       `nanos()`: at a 2026 epoch each endpoint rounds by up to 128 ns and the difference
       inherits both. Observed here as 49 999 872 — the assertion is the bound, so a change
       that made it worse would fail. */
    expect(Math.abs(half!.durationNs - 50 * MS)).toBeLessThanOrEqual(256);
  });

  it("gives a service one colour wherever it appears", () => {
    const result = ok([
      { id: "root", service: "edge", duration: 100 },
      { id: "a", parent: "root", service: "pricing", start: 10, duration: 20 },
      { id: "b", parent: "a", service: "edge", start: 12, duration: 5 },
      { id: "c", parent: "root", service: "pricing", start: 40, duration: 20 },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));

    expect(byName.get("root")!.palette).toBe(byName.get("b")!.palette);
    expect(byName.get("a")!.palette).toBe(byName.get("c")!.palette);
    expect(byName.get("root")!.palette).not.toBe(byName.get("a")!.palette);
    expect(result.summary.serviceCount).toBe(2);
  });

  it("assigns the same colours to the same payload every time", () => {
    /* Stability is a spec requirement, and it is not free: it follows from assignment being in
       render order, which is itself deterministic only because ties break on input order. */
    const specs: SpanSpec[] = [
      { id: "root", service: "edge", duration: 100 },
      { id: "a", parent: "root", service: "pricing", start: 10, duration: 20 },
      { id: "b", parent: "root", service: "tariff", start: 10, duration: 20 },
    ];
    expect(rows(ok(specs)).map((row) => row.palette)).toEqual(
      rows(ok(specs)).map((row) => row.palette),
    );
  });

  it("wraps palette indices into the nine-slot range", () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      service: `svc-${i}`,
      ...(i === 0 ? {} : { parent: "s0" }),
      start: i,
      duration: 5,
    }));
    const palettes = rows(ok(specs)).map((row) => row.palette);
    /* A fortieth service must reuse a colour, not write an index that resolves to no custom
       property and paints an invisible bar. */
    expect(Math.max(...palettes)).toBeLessThan(9);
    expect(ok(specs).summary.serviceCount).toBe(12);
  });

  it("flags an error span from its status code", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "bad", parent: "root", start: 10, duration: 20, error: true },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));
    expect(byName.get("bad")!.flags & F_ERROR).toBe(F_ERROR);
    expect(byName.get("root")!.flags & F_ERROR).toBe(0);
  });

  it("marks only a genuine root as the root", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "kid", parent: "root", start: 10, duration: 20 },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));
    expect(byName.get("root")!.flags & F_ROOT).toBe(F_ROOT);
    expect(byName.get("kid")!.flags & F_ROOT).toBe(0);
  });
});

describe("incomplete traces", () => {
  it("renders an orphan at depth 0 and flags it rather than dropping it", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "lost", parent: "never-ingested", start: 30, duration: 20 },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));

    /* Dropping it would produce a waterfall that looks complete and is not — the exact failure
       this toolbar exists to avoid. A hole the reader can see is a finding. */
    expect(result.count).toBe(2);
    expect(byName.get("lost")!.depth).toBe(0);
    expect(byName.get("lost")!.flags & F_ORPHAN).toBe(F_ORPHAN);
    /* And it is not passed off as the root. */
    expect(byName.get("lost")!.flags & F_ROOT).toBe(0);
  });

  it("breaks a cycle deterministically and flags where it cut", () => {
    const result = ok([
      { id: "a", parent: "c", start: 0, duration: 30 },
      { id: "b", parent: "a", start: 5, duration: 20 },
      { id: "c", parent: "b", start: 10, duration: 10 },
    ]);
    const flagged = rows(result).filter((row) => (row.flags & F_CYCLE) !== 0);

    expect(result.count).toBe(3);
    /* Exactly one link is cut — enough to make the graph a tree, and no more. */
    expect(flagged).toHaveLength(1);
    /* And the same one every time, so two renders of one trace do not disagree. */
    expect(
      rows(
        ok([
          { id: "a", parent: "c", start: 0, duration: 30 },
          { id: "b", parent: "a", start: 5, duration: 20 },
          { id: "c", parent: "b", start: 10, duration: 10 },
        ]),
      ).filter((row) => (row.flags & F_CYCLE) !== 0)[0]!.name,
    ).toBe(flagged[0]!.name);
  });

  it("widens a zero-duration span to something clickable and says it did", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "instant", parent: "root", start: 50, duration: 0 },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));
    const instant = byName.get("instant")!;

    expect(instant.flags & F_DEGENERATE).toBe(F_DEGENERATE);
    expect(instant.width).toBeGreaterThan(0);
    /* The width is a rendering decision and must not be read back as a measurement. */
    expect(instant.durationNs).toBe(0);
  });

  it("does the same for a span that ends before it starts", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "backwards", parent: "root", start: 50, duration: -20 },
    ]);
    const byName = new Map(rows(result).map((row) => [row.name, row]));
    expect(byName.get("backwards")!.flags & F_DEGENERATE).toBe(F_DEGENERATE);
    expect(byName.get("backwards")!.width).toBeGreaterThan(0);
  });

  it("keeps every bar inside the track", () => {
    const result = ok([
      { id: "root", duration: 100 },
      { id: "overrun", parent: "root", start: 90, duration: 500 },
    ]);
    for (const row of rows(result)) {
      expect(row.left).toBeGreaterThanOrEqual(0);
      expect(row.left + row.width).toBeLessThanOrEqual(1.0001);
    }
  });

  it("truncates at the cap and says so", () => {
    const specs = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      ...(i === 0 ? {} : { parent: "s0" }),
      start: i,
      duration: 5,
    }));
    const result = layout(request(otlp(specs)), { cap: 8 });
    if (!result.ok) throw new Error(result.reason);

    expect(result.count).toBe(8);
    expect(result.summary.spanCount).toBe(8);
    /* Both numbers, because the UI has to be able to say *how much* is missing. */
    expect(result.summary.spansSeen).toBe(20);
    expect(result.summary.truncated).toBe(true);
  });

  it("does not claim truncation when the trace merely fits", () => {
    expect(ok([{ id: "root", duration: 10 }]).summary.truncated).toBe(false);
  });

  it("falls back to the query window when the spans supply no scale", () => {
    /* One instantaneous span: extent zero, no denominator. Without the fallback every width is
       a division by zero. */
    const result = ok([{ id: "only", start: 0, duration: 0 }]);
    const [row] = rows(result);
    expect(Number.isFinite(row!.left)).toBe(true);
    expect(Number.isFinite(row!.width)).toBe(true);
    expect(row!.width).toBeGreaterThan(0);
  });
});

describe("failures", () => {
  const bad = (body: string) => layout({ ...request(body), body });

  it("names a malformed body rather than throwing across the boundary", () => {
    const result = bad("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed-json");
    /* Displayable, and free of the body — an error line that echoes a response is how a panel
       leaks something it was handed. */
    expect(result.message).not.toContain("not json");
  });

  it("separates a payload it cannot read from a trace with no spans", () => {
    expect(bad(JSON.stringify({ error: "nope" })).ok).toBe(false);
    expect((bad(JSON.stringify({ error: "nope" })) as { reason: string }).reason).toBe(
      "not-otlp",
    );

    const empty = bad(JSON.stringify({ resourceSpans: [] }));
    expect(empty.ok).toBe(false);
    /* Not the same thing as a parse failure: the query succeeded and the answer was nothing. */
    expect((empty as { reason: string }).reason).toBe("empty");
  });

  it("refuses a version it does not share with the panel", () => {
    const result = layout({ ...request(otlp([{ id: "a" }])), version: 999 });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("version-mismatch");
  });
});

describe("the browser is part of the trace", () => {
  it("lays a web event out as the root, with backend spans under it", () => {
    const result = ok(
      [
        { id: "server", parent: "browser-1", start: 20, duration: 60 },
        { id: "db", parent: "server", start: 30, duration: 20 },
      ],
      {
        webEvents: [
          {
            spanId: "browser-1",
            name: "GET /api/quote",
            origin: "https://app.example.com",
            startTimeUnixNano: String(T0),
            endTimeUnixNano: String(T0 + 100 * MS),
          },
        ],
      },
    );
    const laid = rows(result);

    expect(laid[0]!.name).toBe("GET /api/quote");
    expect(laid[0]!.depth).toBe(0);
    expect(laid[0]!.flags & F_ROOT).toBe(F_ROOT);
    expect(laid.map((row) => row.depth)).toEqual([0, 1, 2]);
    /* Without this the waterfall would start at the first backend span and silently omit
       everything the browser paid for — the half the reader actually controls. */
    expect(laid[0]!.width).toBeCloseTo(1, 5);
  });

  it("does not degrade a trace that has no web event", () => {
    const result = ok([{ id: "server", duration: 60 }]);
    expect(result.count).toBe(1);
    expect(rows(result)[0]!.flags & F_ORPHAN).toBe(0);
  });
});

describe("correlated logs", () => {
  it("counts them and keeps the most severe for the footer", () => {
    const result = ok([{ id: "root", duration: 10 }], {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "cache warm" },
                },
                {
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "tariff lookup failed" },
                },
                {
                  severityNumber: 13,
                  severityText: "WARN",
                  body: { stringValue: "retrying" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.summary.logCount).toBe(3);
    expect(result.summary.log).toEqual({ level: "ERROR", message: "tariff lookup failed" });
  });

  it("reports no log rather than an empty one", () => {
    const result = ok([{ id: "root", duration: 10 }]);
    expect(result.summary.logCount).toBe(0);
    expect(result.summary.log).toBeUndefined();
  });
});

describe("toResponse", () => {
  it("puts the buffer in the transfer list", () => {
    /* The property the spec requires and task 4.2 asserts. Returning the list beside the
       message is what makes forgetting it a type error rather than a silent structured clone —
       asserted here so that a change which drops it fails in node, not in a benchmark. */
    const result = ok([{ id: "root", duration: 10 }]);
    const posted = toResponse(7, result, 1.5);

    expect(posted.transfer).toEqual([result.buffer]);
    expect(posted.message.kind).toBe("layout-ok");
    expect(posted.message.id).toBe(7);
    expect(posted.message.version).toBe(LAYOUT_PROTOCOL_VERSION);
  });

  it("transfers nothing for a failure, and carries the reason", () => {
    const failed = layout({ ...request("{"), body: "{" });
    const posted = toResponse(7, failed, 0.1);
    expect(posted.transfer).toEqual([]);
    expect(posted.message.kind).toBe("layout-error");
  });
});
