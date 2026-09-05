import { expect, test } from "@playwright/test";

/**
 * The untraced view in a real browser.
 *
 * The unit tests settle the classification against a fake ring. What only a browser can settle
 * is whether the inputs the classification depends on are real: whether `initiatorType` on a
 * live page actually separates the parser's fetches from the application's, whether the badge
 * is right before anyone opens the tab, and whether the undeterminable state is reached by the
 * path that produces it rather than by a signal set in a test.
 *
 * The shadow root is closed by design, so `attachShadow` is patched before the bundle runs to
 * capture it — the seam used by every other spec here. Patching from the outside leaves the
 * production path untouched.
 */

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
    __d0root: ShadowRoot | undefined;
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

async function load(page: import("@playwright/test").Page, query: string): Promise<void> {
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => window.__d0root !== undefined);
}

/**
 * Loads with the worker actually controlling the page.
 *
 * Registration is deliberately post-settle, so the worker controls nothing on the load that
 * registered it — coverage is undeterminable on a first visit, correctly, and every assertion
 * about a real reading has to be made from the second load. Same reason `tier2.spec.ts` has
 * this helper; the first version of this file did a single `goto` and timed out waiting for a
 * badge that was right to be absent.
 */
async function loadControlled(
  page: import("@playwright/test").Page,
  query: string,
): Promise<void> {
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });
  await load(page, query);
}

async function openPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
}

/** Clicks the untraced tab by its label, so the test does not depend on tab order. */
async function openUntraced(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const tabs = [...window.__d0root!.querySelectorAll<HTMLElement>(".tab")];
    tabs.find((t) => t.textContent?.startsWith("Untraced"))!.click();
  });
  await page.waitForFunction(() => {
    const view = window.__d0root!.querySelector(".coverage") as HTMLElement | null;
    return view !== null && !view.hidden;
  });
}

test("classifies a live page's own subresources as subresources, not as gaps", async ({
  page,
}) => {
  /* The reason this test exists in a browser at all. The classification reads
     `initiatorType`, which is the browser's word for who issued a request — and the fixture
     loads real stylesheets and real scripts, so this is the only place the value is real. It
     was added after looking at the rendered tab: `/app.css`, `/app.js` and d0bar's own bundle
     were the first three cards, each of them true and none of them something an SDK could
     have attached trace context to. */
  await loadControlled(page, "?d0bar=on");
  await openPanel(page);
  await openUntraced(page);
  await page.waitForFunction(
    () => window.__d0root!.querySelectorAll(".ucard:not([hidden])").length > 0,
    undefined,
    { timeout: 15_000 },
  );

  const cards = await page.evaluate(() =>
    [...window.__d0root!.querySelectorAll<HTMLElement>(".ucard:not([hidden])")].map((card) => ({
      cause: card.dataset["cause"] ?? "",
      url: card.querySelector(".uurl")?.textContent ?? "",
    })),
  );

  const stylesheet = cards.find((card) => card.url.endsWith("/app.css"));
  expect(stylesheet, "the fixture's stylesheet is on the list").toBeDefined();
  expect(stylesheet!.cause, "and it is not an instrumentation gap").toBe("subresource");

  /* And the distinction is being made, not applied to everything: the fixture's `fetch` calls
     to /api/resource are still classified by what the worker saw. */
  const api = cards.filter((card) => card.url.includes("/api/resource"));
  expect(api.length, "the API calls are still listed").toBeGreaterThan(0);
  for (const call of api) {
    expect(call.cause, `${call.url} is not a subresource`).not.toBe("subresource");
  }

  /* Every card carries a cause. A blank one would render as an empty line rather than fail,
     which is the failure mode most likely to survive a screenshot. */
  for (const card of cards) expect(card.cause, `${card.url} has a cause`).not.toBe("");
});

test("states that coverage is unknown with no worker, rather than reporting zero gaps", async ({
  page,
}) => {
  /* The failure this whole view is one line away from. With tier 2 off nothing carries a
     trace id d0bar can see, so a naive count reads `M of M` on a page that may be perfectly
     instrumented — a number that looks like a finding and is an artefact of the measurement
     being absent. `?sw=off` is the same bundle with the worker path deliberately not taken,
     which is the state a host with their own service worker lands in. */
  await load(page, "?d0bar=on&sw=off");
  await openPanel(page);
  await openUntraced(page);

  const state = await page.evaluate(() => {
    const root = window.__d0root!;
    const count = root.querySelector(".coverage-count") as HTMLElement;
    const badge = root.querySelector(".badge") as HTMLElement;
    return {
      kind: count.dataset["kind"] ?? "",
      headline: count.textContent ?? "",
      detail: root.querySelector(".coverage-detail")?.textContent ?? "",
      cards: root.querySelectorAll(".ucard:not([hidden])").length,
      badgeHidden: badge.hidden,
    };
  });

  expect(state.kind, "the headline is the undeterminable state").toBe("undeterminable");
  expect(state.headline).toBe("coverage unknown");
  expect(state.detail, "and says what that is not").toContain("not a report of zero gaps");
  expect(state.cards, "no cards, because there is no reading to list").toBe(0);
  /* Zero so the badge hides — a badge is a count, and there is no count here. */
  expect(state.badgeHidden, "and the badge is hidden rather than showing 0").toBe(true);
});

test("has the badge right before the tab has ever been opened", async ({ page }) => {
  /* The badge is on the tab, so it has to be true *before* anyone visits it. A count that
     only becomes correct once the tab is opened is a count nobody ever sees — the panel opens
     on Requests. */
  await loadControlled(page, "?d0bar=on");
  await openPanel(page);

  await page.waitForFunction(
    () => {
      const badge = window.__d0root!.querySelector(".badge") as HTMLElement | null;
      return badge !== null && !badge.hidden && Number(badge.textContent) > 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  const before = await page.evaluate(() => {
    const root = window.__d0root!;
    return {
      badge: Number(root.querySelector(".badge")!.textContent),
      /* Still on the requests tab — the untraced view has never been shown. */
      onRequests: root.querySelector(".coverage") === null ||
        (root.querySelector(".coverage") as HTMLElement).hidden,
    };
  });
  expect(before.onRequests, "the untraced view has not been displayed").toBe(true);
  expect(before.badge).toBeGreaterThan(0);

  await openUntraced(page);

  /* The headline and the badge come from one `publish()` call, so they cannot disagree. The
     fixture keeps issuing requests, so this compares the two at one instant rather than
     comparing a later reading with an earlier one. */
  const together = await page.evaluate(() => {
    const root = window.__d0root!;
    const headline = root.querySelector(".coverage-count")!.textContent ?? "";
    return { headline, badge: root.querySelector(".badge")!.textContent ?? "" };
  });
  expect(together.headline, `headline "${together.headline}" starts with the badge count`).toBe(
    `${together.badge} of ${together.headline.split(" of ")[1]}`,
  );
});

test("gives the tab one tooltip, carrying the current count", async ({ page }) => {
  /* Regression guard, and the one assertion here that a screenshot could not have made.
     This tab was built with two `tooltip()` calls on the same button — one for the live
     reading, one for the static explanation — and the first ran before the tab had been
     appended to the tab row. `tooltip()` starts with `trigger.replaceWith(anchor)`, which does
     nothing to a parentless node, so that anchor and its bubble ended up detached from the
     document with two live bindings still writing the count into them. The copy existed,
     updated correctly, and no pointer could ever reach it.

     Note what this does *not* assert: the anchor count. Both the broken and the fixed panel
     have exactly one `.tip-anchor` around this tab, because the dead one was never inserted —
     an assertion on it would have passed against the bug. Asserting on the copy the user can
     actually hover is what caught it. */
  await loadControlled(page, "?d0bar=on");
  await openPanel(page);
  await page.waitForFunction(
    () => {
      const badge = window.__d0root!.querySelector(".badge") as HTMLElement | null;
      return badge !== null && !badge.hidden && Number(badge.textContent) > 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  const tab = page.locator("d0-bar").locator(".tab", { hasText: "Untraced" });
  await tab.hover();
  /* Waited for rather than read straight back: the bubble's visibility is a bound effect, so
     it lands on the next flush and not inside the hover call. */
  await page.waitForFunction(() =>
    [...window.__d0root!.querySelectorAll<HTMLElement>(".tip")].some((b) => !b.hidden),
  );

  const shown = await page.evaluate(() => {
    const root = window.__d0root!;
    const tabs = [...root.querySelectorAll<HTMLElement>(".tab")];
    const untraced = tabs.find((t) => t.textContent?.startsWith("Untraced"))!;
    const anchors = [...root.querySelectorAll(".tip-anchor")].filter((a) => a.contains(untraced));
    const bubbles = [...root.querySelectorAll<HTMLElement>(".tip")].filter(
      (b) => !b.hidden && anchors.some((a) => a.contains(b)),
    );
    return {
      anchors: anchors.length,
      visible: bubbles.length,
      text: bubbles[0]?.textContent ?? "",
      badge: root.querySelector(".badge")!.textContent ?? "",
    };
  });

  expect(shown.visible, "exactly one bubble is showing for this tab").toBe(1);
  expect(shown.text, "which leads with the reading").toContain(
    `${shown.badge} of `,
  );
  expect(shown.text, "and still explains what the tab is").toContain("trace context");
});
