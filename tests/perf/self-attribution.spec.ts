import { expect, test } from "@playwright/test";

/**
 * Tier 0, exercised in a real browser: d0bar recognising its own work through the same
 * `long-animation-frame` API the panel uses to report the host's.
 *
 * Two different claims, and only the second one needs a slow machine:
 *
 * ```
 *   load-phase self cost is zero   ──▶  shipped arm, no throttling. A property of the build.
 *   attribution actually resolves  ──▶  dev arm, CPU throttled. A property of the mechanism.
 * ```
 *
 * **`add-self-attribution` task 5.2 asked for the wrong assertion and the spec has been
 * corrected.** It said to drive the panel hard and assert the self-report is non-empty. But the
 * report only fills from frames the browser calls *long* — 50 ms — so on a machine fast enough,
 * an empty report is d0bar being free, which is the outcome this whole repo exists to produce.
 * Asserting non-empty unthrottled would have been a test that fails when the product is good.
 *
 * What is worth proving is that the mechanism can see d0bar at all, so the frames are forced:
 * CPU throttled, then the requests list scrolled, which drives `d0bar:panel-paint` — the
 * marked callback in `panel/virtual.ts` — into frames long enough for Chrome to report. If
 * attribution were broken the total would read a confident zero and look like success, which is
 * exactly the failure mode `shared/mark.ts` exists to make impossible.
 */

interface SelfDiagnostics {
  mode: "url" | "lower-bound" | "unavailable";
  totalMs: number;
  longestFrameMs: number;
  frames: number;
  namedFrames: number;
  loadPhaseMs: number;
  top: Array<{ ms: number; name: string }>;
}

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
    __d0root: ShadowRoot | undefined;
    D0bar: { diagnostics(): { self: SelfDiagnostics; entryTypes: readonly string[] } };
  }
}

const captureShadow = () => {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = original.call(this, { ...init, mode: "open" });
    if (this.tagName === "D0-BAR") window.__d0root = root;
    return root;
  };
};

const readSelf = () => window.D0bar.diagnostics().self;

test("load-phase self cost is exactly zero in the shipped build", async ({ page }) => {
  await page.goto("/?d0bar=on", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  /* Past settle — load, plus 500 ms of LCP quiet, plus one background task. Same figure
     `dev-guard.spec.ts` uses and for the same reason. */
  await page.waitForTimeout(2500);

  const self = await page.evaluate(readSelf);

  /* Chromium reports `long-animation-frame`, so an `unavailable` reading here is attribution
     never having started, not a browser limitation — and a zero it produced would be the
     assumption wearing a measurement's clothes that this change exists to remove. */
  expect(self.mode, `attribution mode (self: ${JSON.stringify(self)})`).not.toBe("unavailable");

  /* Zero *by construction*: the moratorium permits only entry recording before LCP is final,
     so any d0bar script time inside a load-phase long frame is a breach — in the shipped build,
     where `assertSettled` is compiled out and nothing else would say so. */
  expect(
    self.loadPhaseMs,
    `d0bar charged ${self.loadPhaseMs}ms to the host's load phase (self: ${JSON.stringify(self)})`,
  ).toBe(0);
});

test("a forced long frame in the panel is attributed to d0bar, not to the host", async ({
  page,
}) => {
  await page.addInitScript(captureShadow);
  /* The dev arm, because `SelfCost.top` — the named breakdown this asserts on — is `__DEV__`
     only. Retaining a string per frame in the build a customer runs would be d0bar allocating
     on the host's main thread to describe itself. */
  await page.goto("/?d0bar=dev", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => window.__d0root !== undefined);
  await page.waitForTimeout(2500);

  const before = await page.evaluate(readSelf);
  expect(before.loadPhaseMs, "the guarded build does not breach the moratorium either").toBe(0);

  const cdp = await page.context().newCDPSession(page);
  /* 20x. Not a fidelity claim about any real device — it is the smallest lever that reliably
     pushes a repaint of a few dozen rows past Chrome's 50 ms long-frame threshold, which is the
     only way to get a frame to attribute at all on CI hardware. Nothing here is a budget. */
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });

  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".row") !== null, undefined, {
    timeout: 30_000,
  });

  /* Scrolled from inside the page rather than by mouse wheel: a wheel gesture is an
     interaction, and an interaction would put this in INP's way. The property under test is
     about repaint attribution, not about input. */
  await page.evaluate(async () => {
    const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
    for (let i = 0; i < 60; i++) {
      scroll.scrollTop = (i % 20) * 240;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  });

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();

  const after = await page.evaluate(readSelf);
  const report = JSON.stringify(after);

  expect(
    after.frames,
    `no long frame was attributed to d0bar (self: ${report})`,
  ).toBeGreaterThan(0);
  expect(after.totalMs, `self cost (self: ${report})`).toBeGreaterThan(0);
  expect(after.top.length, `the dev self-report is empty (self: ${report})`).toBeGreaterThan(0);

  /**
   * The assertion the whole marking mechanism rests on, and the one that has already failed once.
   *
   * `namedFrames` counts frames Chrome reported with a `d0bar:` `sourceFunctionName`, as opposed
   * to ones matched by URL. It is the only check that can tell a working mark from a dead one:
   * the counts above are satisfied by URL matching alone, so with the marks gone this file would
   * still have read a confident non-zero total. The first implementation built the key at runtime
   * (`{ [PREFIX + name]() {} }`), which yields the right `.name` and the right minified bytes and
   * an empty `sourceFunctionName` — V8 fixes the debug name Chrome reports at parse time. It
   * scored zero here, which is how it was caught. See `shared/mark.ts`.
   *
   * It also matters beyond the mark's own health: this is the only discriminator that reaches
   * stage 2, whose URL is not stage 1's, and the only one that exists at all in `lower-bound`.
   */
  expect(
    after.namedFrames,
    `Chrome reported no d0bar: sourceFunctionName — the marks are dead (self: ${report})`,
  ).toBeGreaterThan(0);

  /* Still zero. Every frame above arrived long after settle, so a non-zero reading now would
     mean the phase attribution is charging post-settle work to the load phase. */
  expect(
    after.loadPhaseMs,
    `load-phase self cost after driving the panel (self: ${report})`,
  ).toBe(0);
});
