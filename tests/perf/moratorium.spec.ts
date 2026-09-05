import { expect, test } from "@playwright/test";

/**
 * The load-phase moratorium, observed from the host page's side.
 *
 * The claim is that while the browser is still recording the page's own LCP and TBT, the
 * toolbar does nothing but write numbers into a preallocated buffer. The host page watches
 * its own DOM to check that, rather than the toolbar reporting on itself.
 */
test("touches nothing in the host document until the load phase has settled", async ({
  page,
}) => {
  await page.goto("/?d0bar=on", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const lcp = performance.getEntriesByType("largest-contentful-paint");
    const metrics = (window as unknown as { __metrics: { d0barMountedAt: number } }).__metrics;
    return {
      mountedAt: metrics.d0barMountedAt,
      loadEventEnd: nav.loadEventEnd,
      lastLcp: lcp.length ? (lcp[lcp.length - 1] as PerformanceEntry).startTime : 0,
      requestsRecorded: performance.getEntriesByType("resource").length,
    };
  });

  /* The fixture really did generate load-phase traffic — otherwise this proves nothing. */
  expect(timing.requestsRecorded).toBeGreaterThan(100);

  expect(timing.mountedAt, "the pill mounted at all").toBeGreaterThan(0);
  expect(timing.mountedAt, "mounted after the load event").toBeGreaterThan(timing.loadEventEnd);
  expect(timing.mountedAt, "mounted after LCP was final").toBeGreaterThan(timing.lastLcp);
});
