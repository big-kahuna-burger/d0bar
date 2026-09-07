import { expect, test } from "@playwright/test";

/**
 * Tier 2 must never claim to be observing while nothing controls the page.
 *
 * `startTier2` used to set `{kind: "live"}` the instant `register()` resolved. Registration
 * succeeding and the worker controlling this page are separate events: `controller` is null until
 * the worker activates *and* claims, and until then no `fetch` event reaches it. So the panel read
 * "2 SW live" while the worker saw nothing and every row read untraced — wrong, and delivered with
 * full confidence.
 *
 * **What this asserts, and what it deliberately does not.** The first version of this spec asserted
 * "pending on a first visit, live after a reload". That passed once and then failed, because it was
 * asserting a race: d0bar's worker calls `skipWaiting()` on install and `clients.claim()` on
 * activate (`src/sw/observe.ts`), so it usually claims the registering page a moment later and the
 * banner goes straight to live with no reload. Whether the claim beats the observation is timing,
 * not behaviour, and a spec that pins it is a flake with a comment.
 *
 * The invariant underneath is not racy and is the actual bug: **the reading and
 * `navigator.serviceWorker.controller` never disagree.** Sampled repeatedly across the window where
 * they used to, so a re-introduced eager `live` is caught whichever way the race falls.
 *
 * Its teeth are limited and worth stating: when the claim wins the race the loop takes one sample
 * and there is no pending window to inspect, so this cannot be the primary guard. That is
 * `tests/unit/tier2-pending.test.ts`, which drives the derivation directly with a fake container.
 * What only a browser can add is that the invariant holds against the real platform.
 *
 * Asserts identity, never a duration.
 */
test("the reading never says live while nothing controls the page", async ({ browser }) => {
  /* Fresh context: the subject is the window right after a *first* registration. A reused profile
     can arrive already controlled, and every sample below would then be the trivial case. */
  const context = await browser.newContext();
  const page = await context.newPage();

  const sample = () =>
    page.evaluate(() => ({
      state: document.getElementById("sw-banner")?.getAttribute("data-state") ?? "",
      controlled: navigator.serviceWorker.controller !== null,
      reload: !document.getElementById("sw-reload")?.hidden,
    }));

  await page.goto("/try/", { waitUntil: "load" });

  /* Sampled across the whole registration window — registration is deferred until the load phase
     settles, so the interesting transitions happen after `load`, not before it. */
  const samples: Awaited<ReturnType<typeof sample>>[] = [];
  for (let i = 0; i < 40; i += 1) {
    samples.push(await sample());
    if (samples.at(-1)!.state === "live") break;
    await page.waitForTimeout(250);
  }

  for (const [i, s] of samples.entries()) {
    /* The bug, stated as an invariant: `live` is a claim that requests are being observed, and
       nothing is observed without a controller. */
    if (s.state === "live") {
      expect(
        s.controlled,
        `sample ${i} read live with no controller: ${JSON.stringify(s)}`,
      ).toBe(true);
    }
    /* And the converse half — pending must offer the remedy, since the reader's only other
       information is a list of rows that all say untraced. */
    if (s.state === "pending") {
      expect(s.reload, `sample ${i} was pending with no reload button`).toBe(true);
    }
  }

  /* If the claim did not land on its own, a reload is the documented remedy — and the copy the
     pending banner shows promises it works, so the promise is exercised rather than trusted. */
  if ((await sample()).state !== "live") await page.reload({ waitUntil: "load" });

  /* The window must actually resolve. A banner stuck on `pending` or `off` would satisfy every
     assertion above while tier 2 observed nothing — the failure this spec exists to notice,
     passing on a technicality. */
  await expect
    .poll(async () => (await sample()).state, {
      timeout: 20_000,
      message: "tier 2 never reached live, even after a reload",
    })
    .toBe("live");

  const live = await sample();
  expect(live.controlled).toBe(true);
  expect(live.reload, "the reload button is still showing once live").toBe(false);

  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  /* Scoped to `/try/`, never to `/` — a root-scoped worker from the demo would go on controlling
     the benchmark arms in this profile, and an arm with a worker under it is not that arm. */
  expect(controller).toContain("/try/d0bar-sw.js");

  await context.close();
});
