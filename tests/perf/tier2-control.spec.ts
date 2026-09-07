import { expect, test } from "@playwright/test";

/**
 * Tier 2 must not claim to be observing before it is.
 *
 * A service worker never controls the page that registered it: `controller` stays null until the
 * worker activates *and* claims, which on a first visit means the next navigation. `startTier2`
 * used to set `{kind: "live"}` the instant `register()` resolved, so on every first load the
 * panel said "2 SW live" while the worker saw no `fetch` event and every row read untraced. The
 * reading was wrong, it was delivered with full confidence, and nothing on screen contradicted
 * it — which is what makes it worth a browser test rather than only a unit test.
 *
 * The unit tests in `tests/unit/tier2-pending.test.ts` move a fake `controller` and check the
 * derivation. They cannot check the premise. Only a real browser can show that control is in
 * fact absent on the first navigation and present on the second, and this asserts exactly that
 * transition — through the page's own banner, so the copy a reader sees is what is under test.
 *
 * Asserts identity and text, never a duration.
 */
test("the /try/ banner reads pending on a first visit and live after a reload", async ({
  browser,
}) => {
  /* A fresh context, because the whole subject is *first* visit. A reused profile can arrive
     already controlled by a worker from an earlier run and the test would assert nothing. */
  const context = await browser.newContext();
  const page = await context.newPage();

  const banner = () =>
    page.evaluate(() => {
      const element = document.getElementById("sw-banner");
      return {
        state: element?.getAttribute("data-state") ?? "",
        text: document.getElementById("sw-text")?.textContent ?? "",
        reload: !document.getElementById("sw-reload")?.hidden,
      };
    });

  await page.goto("/try/", { waitUntil: "load" });

  expect(
    await page.evaluate(() => navigator.serviceWorker.controller),
    "nothing controls the page that registered the worker",
  ).toBeNull();

  /* Polled, not slept: registration is deferred until the load phase settles, so `pending` is
     reached a beat after load. The banner's own `serviceWorker.ready` handler is the edge. */
  await expect
    .poll(async () => (await banner()).state, {
      timeout: 15_000,
      message: "the banner never reached pending — was the worker registered at all?",
    })
    .toBe("pending");

  const pending = await banner();
  expect(pending.text).toContain("NOT controlling");
  /* The remedy has to be an actionable control, not only prose. */
  expect(pending.reload, "the reload button is hidden while pending").toBe(true);

  await page.reload({ waitUntil: "load" });

  await expect.poll(async () => (await banner()).state, { timeout: 15_000 }).toBe("live");
  const live = await banner();
  expect(live.text).toContain("Tier 2 live");
  expect(live.reload, "the reload button is still showing once live").toBe(false);

  /* The banner reads `navigator.serviceWorker.controller`, and so does `tier2State()`, so this
     pins the shared premise rather than d0bar's copy of it — the shadow root is closed and the
     panel's tier strip is not reachable from page script. `tests/unit/tier2-pending.test.ts`
     covers the derivation on top of it. */
  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  expect(controller).toContain("d0bar-sw.js");

  await context.close();
});
