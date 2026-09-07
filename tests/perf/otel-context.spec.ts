import { expect, test } from "@playwright/test";

/**
 * One click on `/try/` must produce **one** trace.
 *
 * This exists because the opposite shipped, and shipped invisibly. Every scenario looked right —
 * spans were created, `traceparent` reached the wire, the panel showed a trace id on every row,
 * and the page printed a trace id that looked like the answer. What it actually produced for a
 * nine-request checkout was **seven traces**:
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
 * The cause is `StackContextManager`, which `@opentelemetry/sdk-trace-web` installs by default
 * and which **does not survive an `await`**: `context.with(ctx, async () => …)` covers the
 * callback's synchronous prologue and nothing past its first suspension point, so every step
 * after the first became a new root span with a new trace id. The three that shared one were the
 * `Promise.allSettled` fan-out, created together before anything suspended — which is the tell.
 *
 * `bench/fixtures/otel/entry.js` now threads the parent `Context` explicitly into `startSpan`
 * and into every log record, and reads `context.active()` nowhere. See the long note above
 * `log()` there for why the fix is not `@opentelemetry/context-zone`.
 *
 * **Why the assertion reads the service worker's log rather than the spans.** The exported spans
 * are what a backend would see, and checking those would need a collector. The worker's own
 * record of each request is the `traceparent` that was actually on the wire, which is the thing
 * that has to be one trace — and it is read from IndexedDB the way the host page can, which
 * `src/sw/protocol.ts` is explicit about.
 *
 * Tagged for the behaviour project: it asserts identity, never a duration.
 */

/**
 * `requests` is how many `/api/` calls each scenario makes, and it is polled for rather than
 * slept on. A fixed wait failed here once already — the dev server's watcher had just rewritten
 * `dist/d0bar-sw.js`, the worker was mid-replacement, and some requests went unrecorded. That is
 * a real condition on a developer's machine and it would be a flake on CI.
 */
const SCENARIOS = [
  { name: "checkout", requests: 9 },
  { name: "search", requests: 9 },
  { name: "cascade", requests: 4 },
  { name: "cold", requests: 11 },
] as const;

test("every /try/ scenario puts all of its requests on one trace", async ({ page }) => {
  await page.goto("/try/", { waitUntil: "load" });
  /* One reload, because a worker does not control the page that registered it on a first visit.
     Without this every record below is absent and the failure reads as a context bug. */
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1500);

  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  expect(
    controller,
    "tier 2 is not controlling the page, so there is nothing to read",
  ).toContain("d0bar-sw.js");

  /** Trace ids the worker recorded for `/api/` requests, oldest first. */
  const recorded = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("d0bar", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = await new Promise<Record<string, unknown>[]>((resolve) => {
        const request = db.transaction("requests").objectStore("requests").getAll();
        request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
        request.onerror = () => resolve([]);
      });
      return all
        .filter((entry) => String(entry["url"]).includes("/api/"))
        .map((entry) => String(entry["traceId"]));
    });

  for (const scenario of SCENARIOS) {
    const before = (await recorded()).length;
    await page.click(`[data-scenario="${scenario.name}"]`);

    /* Polled, not slept. The message on timeout names the shortfall, which is the difference
       between "the context fix regressed" and "the worker was being replaced". */
    await expect
      .poll(async () => (await recorded()).length - before, {
        timeout: 30_000,
        message: `${scenario.name} did not reach ${scenario.requests} recorded requests`,
      })
      .toBe(scenario.requests);

    const ids = (await recorded()).slice(before);
    /* The id the page printed — the root span's. Asserted against rather than merely counting
       distinct ids, because "one trace" that is not the *root's* trace is the same bug wearing a
       passing test: the fan-out case produced three requests agreeing with each other and with
       nothing else. */
    const printed = await page.evaluate(
      () =>
        document
          .getElementById("otel-trace")
          ?.textContent?.match(/trace ([0-9a-f]{32})/)?.[1] ?? "",
    );
    const unique = [...new Set(ids)];

    expect(
      unique,
      `${scenario.name} split into ${unique.length} traces: ${unique.join(", ")}`,
    ).toHaveLength(1);
    expect(
      unique[0],
      `${scenario.name}'s requests are on a trace that is not the root's (${printed})`,
    ).toBe(printed);
    expect(printed, `${scenario.name} printed no trace id`).toMatch(/^[0-9a-f]{32}$/);
  }
});
