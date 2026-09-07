import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    /** One entry per read of the worker's request log, with what that read returned. */
    __reads?: { count: number }[];
  }
}

/**
 * The panel must keep reading the worker's log, not read it once.
 *
 * It read it once — at open — and the shape of the failure was clean: the worker went on logging
 * every request, nothing ever read the log again, and so every request issued after the panel
 * opened rendered untraced for the life of the panel. On `/try/` that is every button click, and
 * the reading was indistinguishable from tier 2 being broken.
 *
 * Measured by counting `getAll` on the `requests` store from page script, before the fix:
 *
 *     before the panel opens          0 reads      6 records written
 *     at panel open                   1 read       6
 *     after a 9-request scenario      1 read      19
 *     after a second one              1 read      28
 *
 * 22 of 28 records were never read. Counting the reads rather than inspecting rows is deliberate:
 * the pill's shadow root is closed, and the read count is upstream of every rendering question, so
 * a failure here names the cause instead of a symptom.
 *
 * Asserts counts and identity, never a duration.
 */
test("the panel re-reads the worker log as new requests arrive", async ({ browser }) => {
  /* Fresh context: a profile already holding a log from an earlier run would start with records
     the page never issued, and the count comparison at the end would be meaningless. */
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.__reads = [];
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
      const request = original.apply(this, args as never) as IDBRequest;
      /* `readAll()` in `src/sw/log.ts` is the only `getAll` on this store, so one entry here is
         one correlation flush. */
      if (this.name === "requests") {
        request.addEventListener("success", () => {
          window.__reads!.push({ count: (request.result as unknown[]).length });
        });
      }
      return request;
    } as typeof IDBObjectStore.prototype.getAll;
  });

  await page.goto("/try/", { waitUntil: "load" });
  /* One reload, so control is guaranteed rather than raced — the worker claims the registering
     page once it activates, but not necessarily before the first request. Without this the log can
     be empty and every assertion below would pass vacuously. */
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });

  const reads = () => page.evaluate(() => window.__reads!.length);
  const lastRead = () => page.evaluate(() => window.__reads!.at(-1)?.count ?? 0);
  const written = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        /* Unversioned deliberately: pinning a number here couples the spec to `DB_VERSION`, and
           pinning one below it throws `VersionError`. */
        const request = indexedDB.open("d0bar");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await new Promise<number>((resolve) => {
        const request = db.transaction("requests").objectStore("requests").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(-1);
      });
    });

  await page.click('[data-scenario="cascade"]');
  await page.waitForTimeout(2000);

  /* Nothing reads the log until someone looks. This is a property worth holding, not an accident:
     a page that never opens the panel pays nothing for the join. */
  expect(await reads(), "the log was read before the panel was opened").toBe(0);

  await page.locator("d0-bar").click();
  await expect.poll(reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  const afterOpen = await reads();
  await page.click('[data-scenario="checkout"]');

  /* The assertion the bug failed. A flush must happen *because new requests arrived*, with no
     further interaction and no reopening of the panel. */
  await expect
    .poll(reads, {
      timeout: 20_000,
      message: "no flush followed a scenario run with the panel already open",
    })
    .toBeGreaterThan(afterOpen);

  await page.click('[data-scenario="search"]');
  await page.waitForTimeout(4000);

  /* And the last flush saw everything the worker had written — the join's input is the whole log,
     so a read that trails the writes is the same bug with a smaller number. */
  const total = await written();
  expect(total).toBeGreaterThan(20);
  await expect
    .poll(lastRead, {
      timeout: 20_000,
      message: `the most recent flush read fewer records than the ${total} the worker wrote`,
    })
    .toBeGreaterThanOrEqual(total);

  await context.close();
});
