// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_PROTOCOL_VERSION,
  layoutBuffer,
  layoutViews,
  type LayoutRequest,
  type LayoutResponse,
} from "../../src/shared/protocol";
import { layoutClient } from "../../src/panel/layout-client";
import { spanScratch } from "../../src/trace/traceMachine";

/**
 * The panel's side of the layout worker, against a fake worker.
 *
 * A fake rather than a real one because what is under test here is the *lifecycle* — when a
 * thread is created, when it is terminated, and what happens to a caller whose request is
 * abandoned, timed out, or answered by a worker one version behind. None of that is observable
 * from a real worker without waiting out real timers, and all of it is a decision this file
 * owns. The flattening itself is `layout.test.ts`'s, and the two together are the pair a
 * browser test only has to confirm.
 */

interface FakeWorker extends Worker {
  readonly posted: LayoutRequest[];
  readonly terminated: boolean;
  reply(response: LayoutResponse, transfer?: Transferable[]): void;
  fail(): void;
}

/** How many workers this factory has built. The lazy-creation assertion is a count. */
let spawned: FakeWorker[] = [];

function fakeWorker(): FakeWorker {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const posted: LayoutRequest[] = [];
  let terminated = false;

  const worker = {
    posted,
    get terminated() {
      return terminated;
    },
    addEventListener(type: string, fn: (event: unknown) => void) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(fn);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    postMessage(message: LayoutRequest) {
      posted.push(message);
    },
    terminate() {
      terminated = true;
    },
    reply(response: LayoutResponse) {
      for (const fn of listeners.get("message") ?? []) fn({ data: response });
    },
    fail() {
      for (const fn of listeners.get("error") ?? []) fn({});
    },
  } as unknown as FakeWorker;

  spawned.push(worker);
  return worker;
}

/** A minimal `layout-ok`, one row, so the client has something real to build views over. */
function okReply(id: number, count = 1): LayoutResponse {
  const buffer = layoutBuffer(count);
  const views = layoutViews(buffer, count);
  for (let i = 0; i < count; i += 1) {
    views.nameId[i] = 0;
    views.serviceId[i] = 1;
    views.depth[i] = i === 0 ? 0 : 1;
    views.left[i] = 0.25;
    views.width[i] = 0.5;
    views.durationNs[i] = 412_000_000;
    views.paletteIndex[i] = 3;
    views.flags[i] = 0;
  }
  return {
    kind: "layout-ok",
    version: LAYOUT_PROTOCOL_VERSION,
    id,
    buffer,
    count,
    strings: ["GET /api/quote", "edge"],
    summary: {
      spanCount: count,
      spansSeen: count,
      serviceCount: 1,
      logCount: 0,
      truncated: false,
      totalDurationNs: 824_000_000,
    },
    workerMs: 4.25,
  };
}

beforeEach(() => {
  spawned = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lifecycle", () => {
  it("creates no worker until a trace is actually laid out", () => {
    /* Opening the panel must cost a panel. A developer who never opens a trace never pays for
       a thread, which is why the client is constructed eagerly and the worker is not. */
    const client = layoutClient({ spawn: fakeWorker });
    expect(spawned).toHaveLength(0);
    client.destroy();
  });

  it("reuses one worker across traces", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const first = client.flatten("{}", 0, 1);
    spawned[0]!.reply(okReply(spawned[0]!.posted[0]!.id));
    await first;

    const second = client.flatten("{}", 0, 1);
    spawned[0]!.reply(okReply(spawned[0]!.posted[1]!.id));
    await second;

    expect(spawned).toHaveLength(1);
    client.destroy();
  });

  it("terminates the worker after an idle period, and builds a fresh one next time", async () => {
    const client = layoutClient({ spawn: fakeWorker, idleMs: 1000 });
    const first = client.flatten("{}", 0, 1);
    spawned[0]!.reply(okReply(spawned[0]!.posted[0]!.id));
    await first;

    expect(spawned[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1000);
    /* A page left on a dashboard overnight should not be holding a thread for a trace somebody
       looked at once. */
    expect(spawned[0]!.terminated).toBe(true);

    const second = client.flatten("{}", 0, 1);
    expect(spawned).toHaveLength(2);
    spawned[1]!.reply(okReply(spawned[1]!.posted[0]!.id));
    await second;
    client.destroy();
  });

  it("does not terminate a worker that is still working", async () => {
    const client = layoutClient({ spawn: fakeWorker, idleMs: 1000 });
    const pending = client.flatten("{}", 0, 1);
    vi.advanceTimersByTime(5000);
    /* The idle timer must never pull the thread out from under a layout in flight. */
    expect(spawned[0]!.terminated).toBe(false);

    spawned[0]!.reply(okReply(spawned[0]!.posted[0]!.id));
    await pending;
    client.destroy();
  });

  it("terminates on destroy and tells anyone still waiting", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    client.destroy();

    await expect(pending).rejects.toThrow(/panel closed/i);
    expect(spawned[0]!.terminated).toBe(true);
  });
});

describe("replies", () => {
  it("hands back rows read straight out of the buffer", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    spawned[0]!.reply(okReply(spawned[0]!.posted[0]!.id));
    const flattened = await pending;

    const out = spanScratch();
    expect(flattened.rows.count).toBe(1);
    expect(flattened.rows.read(0, out)).toBe(true);
    expect(out.name).toBe("GET /api/quote");
    expect(out.service).toBe("edge");
    expect(out.left).toBeCloseTo(0.25, 5);
    /* Nanoseconds on the wire, milliseconds at the row — one divide, on a row about to be
       painted, rather than four thousand of them on arrival. */
    expect(out.durationMs).toBeCloseTo(412, 3);
    expect(out.colorIndex).toBe(3);

    /* Out of range answers false rather than throwing or returning a half-filled record. */
    expect(flattened.rows.read(1, out)).toBe(false);
    expect(flattened.rows.read(-1, out)).toBe(false);

    expect(flattened.workerMs).toBe(4.25);
    client.destroy();
  });

  it("carries the request's body and window to the worker", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten('{"resourceSpans":[]}', 100, 200);
    const sent = spawned[0]!.posted[0]!;

    expect(sent.kind).toBe("layout");
    expect(sent.version).toBe(LAYOUT_PROTOCOL_VERSION);
    expect(sent.body).toBe('{"resourceSpans":[]}');
    expect(sent.from).toBe(100);
    expect(sent.to).toBe(200);

    spawned[0]!.reply(okReply(sent.id));
    await pending;
    client.destroy();
  });

  it("drops a reply for a request nobody is waiting on", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    const id = spawned[0]!.posted[0]!.id;

    /* A worker finishing an abandoned layout posts a reply for an id the client no longer
       holds. It must be dropped, not resolved into something. */
    spawned[0]!.reply(okReply(id + 999));
    spawned[0]!.reply(okReply(id));
    await expect(pending).resolves.toMatchObject({ workerMs: 4.25 });
    client.destroy();
  });

  it("rejects a worker one version behind rather than reading the bytes anyway", async () => {
    /* The worst failure this module can have: right bytes, wrong offsets, a waterfall that
       looks plausible and is wrong. Refused instead. */
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    const reply = okReply(spawned[0]!.posted[0]!.id);
    spawned[0]!.reply({ ...reply, version: LAYOUT_PROTOCOL_VERSION + 1 });

    await expect(pending).rejects.toThrow(/different versions/i);
    client.destroy();
  });

  it("surfaces a worker's error message as the rejection", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{", 0, 1);
    spawned[0]!.reply({
      kind: "layout-error",
      version: LAYOUT_PROTOCOL_VERSION,
      id: spawned[0]!.posted[0]!.id,
      reason: "malformed-json",
      message: "The trace response was not valid JSON, so there is nothing to lay out.",
    });
    await expect(pending).rejects.toThrow(/not valid JSON/);
    client.destroy();
  });

  it("tells every caller when the worker fails to load at all", async () => {
    /* A 404 on the sibling script, or a CSP that forbids workers. Arrives as an `error` event,
       not as a reply — so a client that only listens for messages waits forever. */
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    spawned[0]!.fail();

    await expect(pending).rejects.toThrow(/could not start its layout worker/i);
    expect(spawned[0]!.terminated).toBe(true);

    /* And the next attempt builds a fresh one rather than talking to a dead handle. */
    const retry = client.flatten("{}", 0, 1);
    expect(spawned).toHaveLength(2);
    spawned[1]!.reply(okReply(spawned[1]!.posted[0]!.id));
    await retry;
    client.destroy();
  });

  it("gives up on a worker that missed its deadline", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const pending = client.flatten("{}", 0, 1);
    vi.advanceTimersByTime(15_000);

    await expect(pending).rejects.toThrow(/did not finish in time/i);
    /* Not trusted with the next trace. */
    expect(spawned[0]!.terminated).toBe(true);
    client.destroy();
  });
});

describe("cancellation", () => {
  it("rejects immediately for an already-aborted signal, without starting a worker", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const controller = new AbortController();
    controller.abort();

    await expect(client.flatten("{}", 0, 1, controller.signal)).rejects.toThrow(/cancelled/i);
    expect(spawned).toHaveLength(0);
    client.destroy();
  });

  it("rejects on abort but leaves the worker alive", async () => {
    const client = layoutClient({ spawn: fakeWorker });
    const controller = new AbortController();
    const pending = client.flatten("{}", 0, 1, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
    /* Killing the thread on every selection change would make each one cost a worker start,
       and the panel would spend more time booting workers than laying traces out. The
       abandoned reply is dropped when it arrives. */
    expect(spawned[0]!.terminated).toBe(false);

    const next = client.flatten("{}", 0, 1);
    expect(spawned).toHaveLength(1);
    spawned[0]!.reply(okReply(spawned[0]!.posted[1]!.id));
    await expect(next).resolves.toBeTruthy();
    client.destroy();
  });
});
