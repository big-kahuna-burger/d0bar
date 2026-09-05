import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { append, loggingDegraded, prune, readAll, resetLog } from "../../src/sw/log";
import { MAX_AGE_MS, MAX_RECORDS, type FetchRecord } from "../../src/sw/protocol";

/**
 * The worker's durable request log.
 *
 * Two properties matter more than the storage mechanics, and both are about what happens
 * when things go wrong: the log must survive a reload — the request that caused an error is
 * exactly the one someone reloads to look at — and a storage failure must degrade the
 * reading rather than propagate. An exception from here lands inside a `fetch` handler that
 * is observing a customer's request.
 */

function record(over: Partial<FetchRecord> = {}): FetchRecord {
  return {
    order: 0,
    url: "https://example.test/api/thing",
    method: "GET",
    at: Date.now(),
    traceId: "",
    spanId: "",
    sampled: false,
    destination: "empty",
    ...over,
  };
}

beforeEach(async () => {
  resetLog();
  /* fake-indexeddb keeps one global instance across tests; delete the database so each
     test starts from an empty store rather than inheriting the previous one's rows. */
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("d0bar");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  resetLog();
});

describe("append and read", () => {
  it("round-trips a record with its trace context", async () => {
    await append(
      record({
        order: 1,
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        sampled: true,
        method: "POST",
      }),
    );

    const all = await readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      order: 1,
      method: "POST",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sampled: true,
    });
  });

  it("returns records in insertion order", async () => {
    for (let i = 0; i < 5; i += 1) await append(record({ order: i }));
    expect((await readAll()).map((r) => r.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("survives the connection being dropped, as a reload does", async () => {
    await append(record({ order: 7, traceId: "a".repeat(32) }));
    /* A reload tears down the page's realm and every handle in it. The database is the
       thing that is supposed to outlive that, so the test closes the connection rather
       than politely reusing it. */
    resetLog();

    const all = await readAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.order).toBe(7);
  });
});

describe("bounds", () => {
  it("prunes records past the age bound", async () => {
    const now = Date.now();
    await append(record({ order: 1, at: now - MAX_AGE_MS - 60_000 }));
    await append(record({ order: 2, at: now - 60_000 }));

    await prune(now);

    expect((await readAll()).map((r) => r.order)).toEqual([2]);
  });

  it("prunes oldest-first past the count bound", async () => {
    const now = Date.now();
    const total = MAX_RECORDS + 10;
    for (let i = 0; i < total; i += 1) await append(record({ order: i, at: now }));

    await prune(now);

    const all = await readAll();
    expect(all).toHaveLength(MAX_RECORDS);
    /* The oldest ten went, not the newest ten: a log that drops the most recent requests
       is useless for the case it exists to serve. */
    expect(all[0]?.order).toBe(10);
  });
});

describe("storage failure", () => {
  it("degrades instead of throwing into the fetch handler", async () => {
    expect(loggingDegraded()).toBe(false);

    /* Simulate the quota rejection by making the store's write path fail. The behaviour
       under test is the handler's, not IndexedDB's: whatever the reason, a failed write
       must latch the degraded flag and resolve. */
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("simulated quota exhaustion", "QuotaExceededError");
    } as typeof original;

    try {
      await expect(append(record())).resolves.toBeUndefined();
      expect(loggingDegraded()).toBe(true);
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  });

  it("stops logging once degraded rather than retrying every request", async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("simulated quota exhaustion", "QuotaExceededError");
    } as typeof original;
    try {
      await append(record());
    } finally {
      IDBObjectStore.prototype.put = original;
    }

    /* Storage works again, but the log is already known to be incomplete. Resuming would
       produce a log with a hole in it that reads as continuous — worse than one that
       stopped and says so. */
    await append(record({ order: 99 }));
    expect(await readAll()).toHaveLength(0);
    expect(loggingDegraded()).toBe(true);
  });
});
