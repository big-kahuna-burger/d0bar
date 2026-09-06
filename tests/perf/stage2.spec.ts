import { expect, test } from "@playwright/test";

/**
 * The delivery split.
 *
 * Stage 1 is the only thing on a host page's critical path, and that claim is worth exactly
 * as much as the assertion that stage 2 is not fetched alongside it. `size-limit` measures
 * stage 1 alone; these tests are what make measuring it alone honest.
 *
 * Every assertion here is about *when* a request happens, so each one records request URLs
 * against a timeline rather than checking a final state — a stage 2 fetched during load and a
 * stage 2 fetched after settle leave identical end states and have opposite meanings.
 */

const STAGE_2 = "d0bar.panel.js";

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
  }
}

/** Records every stage 2 request with the time it was issued, relative to page start. */
async function watchStage2(page: import("@playwright/test").Page): Promise<number[]> {
  const at: number[] = [];
  const started = Date.now();
  page.on("request", (request) => {
    if (request.url().includes(STAGE_2)) at.push(Date.now() - started);
  });
  return at;
}

test.describe("stage 2 delivery", () => {
  test("is not requested before the panel is opened", async ({ page }) => {
    const requests = await watchStage2(page);

    /* The prefetch is deliberately scheduled after settle, so this navigates and then checks
       immediately — before the moratorium can have lifted. A stage 2 request in this window
       would be one competing with the host's own critical requests. */
    await page.goto("/?d0bar=on", { waitUntil: "domcontentloaded" });

    expect(
      requests,
      "stage 2 must not be fetched during the host page's load phase",
    ).toHaveLength(0);
  });

  test("is not requested at all when the toolbar is gated off", async ({ page }) => {
    const requests = await watchStage2(page);

    /* The gated arm loads the identical bundle and starts nothing. If it fetched the panel,
       every A/B comparison against it would be measuring a download the `off` arm never
       makes — and the baseline would be the thing that is wrong. */
    await page.goto("/?d0bar=gated", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    await page.waitForTimeout(3000);

    expect(requests, "a gated toolbar must fetch nothing").toHaveLength(0);
  });

  test("prefetch lands after the load phase, never inside it", async ({ page }) => {
    const requests = await watchStage2(page);

    await page.goto("/?d0bar=on", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);

    const loadEnd = await page.evaluate(
      () =>
        (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)
          .loadEventEnd,
    );

    /* The prefetch waits on settle, which is the LCP quiet period after load — so it cannot
       be instant. Waiting generously here proves it eventually arrives without asserting a
       specific delay, which would be asserting the scheduler's timing rather than the rule. */
    await page.waitForTimeout(4000);

    expect(requests.length, "the panel should be prefetched once the page has settled").toBe(1);
    expect(
      requests[0]!,
      `prefetch at ${requests[0]}ms must fall after loadEventEnd (${loadEnd}ms)`,
    ).toBeGreaterThan(loadEnd);
  });

  test("a click before the prefetch still opens the panel exactly once", async ({ page }) => {
    const requests = await watchStage2(page);

    await page.goto("/?d0bar=on", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);

    /* The pill only exists after settle, which is also when the prefetch is scheduled — so a
       click here races it. Both paths must resolve to the same single module: `loadStage2`
       caches the in-flight promise precisely so a click during a prefetch joins it. */
    await page.waitForFunction(() => document.querySelector("d0-bar") !== null);
    await page.locator("d0-bar").click();
    await page.waitForTimeout(2000);

    expect(requests.length, "a click during a prefetch must not fetch the panel twice").toBe(1);
  });
});
