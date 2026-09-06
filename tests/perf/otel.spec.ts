import { expect, test } from "@playwright/test";

/**
 * Tier 4 in a real browser, against a real OpenTelemetry SDK.
 *
 * Everything else about tier 4 is testable from a fake — the detection ladder, the sink, the
 * join — and all of it is. What is not testable from a fake is the one claim the tier rests
 * on: that a real `WebTracerProvider`, constructed the way a customer constructs it, hands
 * d0bar's processor real spans, and that d0bar reads them without touching anything else.
 * The fakes in `otel.test.ts` reproduce shapes that were *measured*, but a shape that was
 * measured in a probe six changes ago is still a shape someone wrote down.
 *
 * `/otel.html` is the only page that loads an SDK. The observer-effect arms all run against
 * `/`, which has none — the fixture is the instrument, and an instrument carrying 100 kB of
 * someone else's tracing code is not one.
 */

declare global {
  interface Window {
    __d0root: ShadowRoot | undefined;
    __otelDone: boolean | undefined;
    __fixtureReady: Promise<void>;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const root = original.call(this, { ...init, mode: "open" });
      if (this.tagName === "D0-BAR") window.__d0root = root;
      return root;
    };
  });
});

/** Loads the SDK page and waits for its traced requests to have finished. */
async function loadTraced(page: import("@playwright/test").Page) {
  await page.goto("/otel.html", { waitUntil: "load" });
  await page.waitForFunction(() => window.__otelDone === true, undefined, { timeout: 15_000 });
  await page.waitForFunction(() => window.__d0root !== undefined, undefined, {
    timeout: 15_000,
  });
}

/** Reads the footer's four tiers, with the tooltip bubbles stripped off the labels. */
async function readTiers(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const root = window.__d0root!;
    const labelOf = (tier: Element) => {
      const copy = tier.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".tip").forEach((bubble) => bubble.remove());
      return copy.textContent?.trim();
    };
    return [...root.querySelectorAll(".tier")].map((tier) => ({
      state: (tier as HTMLElement).dataset["state"],
      label: labelOf(tier),
      detail: tier.querySelector(".tip")?.textContent?.trim() ?? "",
    }));
  });
}

test.describe("with a real SDK installed", () => {
  test("reports tier 4 live, owned by the host", async ({ page }) => {
    await loadTraced(page);
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    const tiers = await readTiers(page);
    expect(tiers[3]).toMatchObject({ state: "live", label: "4 OTel SDK" });
    /* Owner `host`, because a 2.x provider takes its processors at construction — the whole
       reason `otelSpanProcessor()` is public. If this ever reads as the d0bar-owned copy,
       something started self-attaching. */
    expect(tiers[3]?.detail).toContain("The host installed d0bar's span processor");
  });

  test("adopts the spans, giving traced rows a trace id the worker never supplied", async ({
    page,
  }) => {
    await loadTraced(page);
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".row") !== null);

    /* The flush is post-settle and asynchronous, so the chips arrive after the first paint.
       Waiting on the count rather than sleeping. */
    await page.waitForFunction(
      () => window.__d0root!.querySelectorAll('.chip[data-traced="true"]').length >= 3,
      undefined,
      { timeout: 15_000 },
    );

    const rows = await page.evaluate(() =>
      [...window.__d0root!.querySelectorAll(".row")].map((row) => ({
        path: row.querySelector(".path")?.textContent ?? "",
        traced: (row.querySelector(".chip") as HTMLElement | null)?.dataset["traced"],
      })),
    );

    const traced = rows.filter((row) => row.path.includes("i=90") && row.traced === "true");
    expect(traced.length).toBeGreaterThanOrEqual(3);
  });

  test("leaves fetch unpatched on a page that has an SDK", async ({ page }) => {
    /* The claim that matters most, on the page most able to disprove it. The fixture calls
       `fetch` inside spans it creates by hand rather than using
       `@opentelemetry/instrumentation-fetch`, precisely so that a patched `fetch` here could
       only have come from d0bar. */
    await loadTraced(page);
    const patched = await page.evaluate(() =>
      Function.prototype.toString.call(window.fetch).includes("[native code]"),
    );
    expect(patched).toBe(true);
  });
});

test.describe("without an SDK", () => {
  test("reports tier 4 off with the ordinary reason, not as a failure", async ({ page }) => {
    /* The overwhelming majority of pages. `no-sdk` must read as a statement about the page
       rather than as something the host should go and fix. */
    await page.goto("/?d0bar=on", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    await page.waitForFunction(() => window.__d0root !== undefined);
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    const tiers = await readTiers(page);
    expect(tiers[3]).toMatchObject({ state: "off", label: "4 OTel SDK off" });
    expect(tiers[3]?.detail).toContain("no OpenTelemetry SDK registered");
    /* Not `planned`. Tier 4 exists now, so saying it is unbuilt would be the wrong kind of
       false in the opposite direction. */
    expect(tiers[3]?.state).not.toBe("planned");
  });
});
