import { expect, test } from "@playwright/test";

/**
 * The development guard, exercised.
 *
 * `assertSettled` throws if anything derives, writes DOM, posts to a worker or fetches during
 * the host's load phase — and it is `__DEV__`-guarded, so in every other arm of this suite it
 * is compiled out and has never executed. `?d0bar=dev` loads a stage-1 build with it compiled
 * in. That build is not published and is never what `?d0bar=on` loads: the measured arms stay
 * the shipped bytes.
 */
test("reaches settle with the moratorium guard compiled in, and throws nothing", async ({
  page,
}) => {
  /* `pageerror` only. The fixture deliberately requests failing routes, so its console
     carries 500s in every arm — counting those would make this assert the fixture's own
     traffic rather than the guard. An `assertSettled` throw surfaces as an uncaught error. */
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/?d0bar=dev", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  /* A fixed wait rather than `waitForFunction` on the mount: when the guard fires, the pill
     never mounts, and a poll for it would hang until Playwright's timeout instead of failing
     with the thrown message attached. Settle is load plus 500 ms of LCP quiet plus one
     background task, so 2.5 s is comfortably past it on this fixture. */
  await page.waitForTimeout(2500);
  const mountedAt = await page.evaluate(
    () => (window as { __metrics?: { d0barMountedAt: number } }).__metrics!.d0barMountedAt,
  );

  /* The guard really is in this build — otherwise the clean run proves nothing. */
  const guarded = await page.evaluate(async () => {
    const response = await fetch("/dist/d0bar.dev.iife.js");
    return (await response.text()).includes("Only entry recording is permitted before settle");
  });
  expect(guarded, "the dev bundle carries the guard's message").toBe(true);

  const shipped = await page.evaluate(async () => {
    const response = await fetch("/dist/d0bar.iife.js");
    return (await response.text()).includes("Only entry recording is permitted before settle");
  });
  expect(shipped, "the shipped bundle does not").toBe(false);

  expect(errors, errors.join("\n")).toEqual([]);
  expect(mountedAt, "the pill mounted, so the guarded path really ran").toBeGreaterThan(0);
});
