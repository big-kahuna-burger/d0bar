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
    const metrics = (window as unknown as { __metrics: Metrics }).__metrics;
    return {
      mountedAt: metrics.d0barMountedAt,
      loadEventEnd: nav.loadEventEnd,
      /* The fixture's own instrument, not `getEntriesByType`. `largest-contentful-paint` is
         observer-only: `performance.getEntriesByType` returns an empty array for it on every
         browser, so the value this assertion used to compare against was always `0` and the
         LCP check collapsed into the load-event check above it. The same platform fact broke
         the vitals fixture recorder in `add-vitals-view`. */
      lcp: metrics.lcp,
      lcpAtMount: metrics.lcpAtMount,
      firstRequestAt: metrics.d0barFirstRequestAt,
      swRegisterAt: metrics.d0barSwRegisterAt,
      workerMessageAt: metrics.d0barWorkerMessageAt,
      requestsRecorded: performance.getEntriesByType("resource").length,
    };
  });

  /* The fixture really did generate load-phase traffic — otherwise this proves nothing. */
  expect(timing.requestsRecorded).toBeGreaterThan(100);

  /* And it really did produce an LCP. Without this the comparison below is a tautology again,
     in a quieter way: `0` is less than every mount time. */
  expect(timing.lcp, "the page reported an LCP").toBeGreaterThan(0);

  expect(timing.mountedAt, "the pill mounted at all").toBeGreaterThan(0);
  expect(timing.mountedAt, "mounted after the load event").toBeGreaterThan(timing.loadEventEnd);
  /**
   * Mounted after every LCP candidate the browser had produced by then.
   *
   * Deliberately not "after the final LCP", which is not a property the toolbar can hold and
   * never was. This fixture paints its hero from a fetch delayed 800 ms, so the page's LCP
   * lands at ~1.58 s while the toolbar settles at ~0.60 s — and no settle heuristic can do
   * better, because LCP is final only at first input or at hidden, neither of which happens on
   * a page nobody touches. The assertion that used to stand here read
   * `performance.getEntriesByType("largest-contentful-paint")`, which always returns an empty
   * array, so it compared against `0` and passed vacuously; reading the real value is what
   * exposed this.
   *
   * The claim that survives is the one that matters, and it is measured rather than asserted
   * here: d0bar does not move the host's LCP. Over five runs each, `on` gave
   * [1588, 1580, 1580, 1564, 1568] ms and `gated` gave [1560, 1560, 1568, 1564, 1580] — the
   * same number within the fixture's own spread. `ab.spec.ts` is where that comparison lives.
   */
  expect(timing.lcpAtMount, "the page had reported an LCP before the pill mounted").toBeGreaterThan(
    0,
  );
  expect(
    timing.mountedAt,
    "mounted after every LCP candidate the browser had produced",
  ).toBeGreaterThan(timing.lcpAtMount);

  /* A DOM insertion was the only side effect this file checked. The moratorium forbids four,
     and the boundary each is checked against is the pill mount rather than the load event:
     the pill mounts at settle, and settle is load plus LCP quiet plus one background task, so
     it is the later and stricter line. `-1` means the side effect never happened at all,
     which is the ordinary case for the worker paths on an arm that configures no `sw`. */
  const notBefore = (at: number, boundary: number): boolean => at < 0 || at >= boundary;

  expect(
    notBefore(timing.firstRequestAt, timing.mountedAt),
    `first d0bar request at ${timing.firstRequestAt}, pill mounted at ${timing.mountedAt}`,
  ).toBe(true);
  expect(
    notBefore(timing.swRegisterAt, timing.mountedAt),
    `worker registration at ${timing.swRegisterAt}, pill mounted at ${timing.mountedAt}`,
  ).toBe(true);
  expect(
    notBefore(timing.workerMessageAt, timing.mountedAt),
    `worker message at ${timing.workerMessageAt}, pill mounted at ${timing.mountedAt}`,
  ).toBe(true);
});

/**
 * The moratorium ends at settle, per the standard's definition of a final LCP. The toolbar's
 * own network requests do not — a prefetch justified by "must not compete with the host page's
 * own critical requests" would do exactly that if a click during load released it.
 */
test("issues no request of its own when the page is clicked before it has loaded", async ({
  page,
}) => {
  /* `?slowload` holds the fixture's load event open for ~900 ms. Without it the fixture loads
     in ~140 ms and there is no window to click inside — this test passed with the gate it
     guards removed, which is exactly the failure mode the change exists to stop shipping. */
  await page.goto("/?d0bar=on&slowload=900", { waitUntil: "commit" });
  await page.waitForTimeout(150);
  await page.mouse.click(200, 200);
  await page.waitForLoadState("load");
  await page.evaluate(() => window.__fixtureReady);

  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const metrics = (window as unknown as { __metrics: Metrics }).__metrics;
    return {
      loadEventEnd: nav.loadEventEnd,
      firstInput: performance.getEntriesByType("first-input")[0]?.startTime ?? -1,
      firstRequestAt: metrics.d0barFirstRequestAt,
      swRegisterAt: metrics.d0barSwRegisterAt,
    };
  });

  /* The click has to have arrived before load, or this test asserts nothing. */
  expect(timing.firstInput, "a first input was recorded").toBeGreaterThanOrEqual(0);
  expect(timing.firstInput, "the click landed before the load event").toBeLessThan(
    timing.loadEventEnd,
  );

  const notBefore = (at: number, boundary: number): boolean => at < 0 || at >= boundary;
  expect(
    notBefore(timing.firstRequestAt, timing.loadEventEnd),
    `first d0bar request at ${timing.firstRequestAt}, load ended at ${timing.loadEventEnd}`,
  ).toBe(true);
  expect(
    notBefore(timing.swRegisterAt, timing.loadEventEnd),
    `worker registration at ${timing.swRegisterAt}, load ended at ${timing.loadEventEnd}`,
  ).toBe(true);
});

interface Metrics {
  lcp: number;
  lcpAtMount: number;
  d0barMountedAt: number;
  d0barFirstRequestAt: number;
  d0barSwRegisterAt: number;
  d0barWorkerMessageAt: number;
}
