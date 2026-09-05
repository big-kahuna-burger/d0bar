import { expect, test } from "@playwright/test";

/**
 * The properties the budget cannot express.
 *
 * A timing budget can only say the toolbar is currently cheap. These assert that it is
 * structurally incapable of the things a toolbar usually does wrong: patching globals,
 * leaking styles into the host document, or doing anything at all when it was not asked to.
 */

interface Pristine {
  fetch: typeof fetch;
  fetchSource: string;
  xhrOpen: typeof XMLHttpRequest.prototype.open;
  xhrSend: typeof XMLHttpRequest.prototype.send;
}

declare global {
  interface Window {
    __pristine: Pristine;
    __fixtureReady: Promise<void>;
  }
}

test.describe("with the toolbar enabled", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?d0bar=on", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
  });

  test("leaves fetch and XMLHttpRequest strictly unpatched", async ({ page }) => {
    const verdict = await page.evaluate(() => ({
      fetchSame: window.fetch === window.__pristine.fetch,
      fetchSourceSame:
        Function.prototype.toString.call(window.fetch) === window.__pristine.fetchSource,
      fetchNative: Function.prototype.toString.call(window.fetch).includes("[native code]"),
      openSame: XMLHttpRequest.prototype.open === window.__pristine.xhrOpen,
      sendSame: XMLHttpRequest.prototype.send === window.__pristine.xhrSend,
    }));

    expect(verdict).toEqual({
      fetchSame: true,
      fetchSourceSame: true,
      fetchNative: true,
      openSame: true,
      sendSame: true,
    });
  });

  test("adds no rule to the host document", async ({ page }) => {
    const styles = await page.evaluate(() => ({
      /* The host document must contain only the fixture's own stylesheet. Counting sheets
         against an early snapshot would only prove the page loaded its own CSS. */
      hrefs: Array.from(document.styleSheets).map((s) => s.href),
      injectedStyleTags: document.querySelectorAll("head style").length,
      /* d0bar's styles live in a constructed stylesheet on a closed shadow root, so they
         are not reachable from the host document at all. */
      adopted: document.adoptedStyleSheets.length,
    }));

    expect(styles.hrefs).toEqual([new URL("/app.css", page.url()).href]);
    expect(styles.injectedStyleTags).toBe(0);
    expect(styles.adopted).toBe(0);
  });

  test("mounts exactly one element, and only after the load phase", async ({ page }) => {
    const dom = await page.evaluate(() => {
      const hosts = document.querySelectorAll("d0-bar");
      return {
        count: hosts.length,
        /* A closed shadow root is not reachable from the page. */
        shadowReachable: hosts[0] ? (hosts[0] as HTMLElement).shadowRoot !== null : true,
        parent: hosts[0]?.parentElement?.tagName ?? null,
      };
    });

    expect(dom.count).toBe(1);
    expect(dom.shadowReachable).toBe(false);
    expect(dom.parent).toBe("BODY");
  });

  test("records nothing into the host page's own storage", async ({ page }) => {
    const storage = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    }));

    expect(storage).toEqual({ local: 0, session: 0, cookies: "" });
  });
});

test.describe("with the toolbar present but not enabled", () => {
  test("does nothing at all", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto("/?d0bar=gated", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);

    const verdict = await page.evaluate(async () => ({
      bundleLoaded: Boolean(
        performance.getEntriesByType("resource").some((e) => e.name.includes("d0bar.iife.js")),
      ),
      elements: document.querySelectorAll("d0-bar").length,
      defined: Boolean(customElements.get("d0-bar")),
      fetchSame: window.fetch === window.__pristine.fetch,
      styleTags: document.querySelectorAll("head style").length,
      adopted: document.adoptedStyleSheets.length,
      workers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
    }));

    /* The bundle really is on the page — otherwise this test proves nothing. */
    expect(verdict.bundleLoaded).toBe(true);
    expect(verdict.elements).toBe(0);
    expect(verdict.defined).toBe(false);
    expect(verdict.fetchSame).toBe(true);
    expect(verdict.styleTags).toBe(0);
    expect(verdict.adopted).toBe(0);
    expect(verdict.workers).toBe(0);

    /* Loading the bundle is the host's own request. Beyond that the toolbar issues none.
       Matched on the path, not the whole URL — the fixture selects its arm with a `d0bar`
       query parameter, so matching the URL would catch the page's own navigation. */
    const ours = requests.filter((url) => {
      const path = new URL(url).pathname;
      return path.includes("d0bar") && !path.endsWith("d0bar.iife.js");
    });
    expect(ours).toEqual([]);
  });
});

/**
 * The toolbar's listener budget on the host page is exactly one, and it is named here.
 *
 * This was zero until the keyboard shortcut landed. Load, visibility and first input all
 * arrive as performance entries, so none of them costs a listener — but there is no entry
 * type for a keypress, and a shortcut that opens the panel before stage 2 has been fetched
 * cannot be built without one. The trade was made deliberately; what must not happen is the
 * budget quietly becoming "a few".
 *
 * So the assertion is an allow-list, not a count. `EXPECTED_LISTENERS` is the whole of what
 * the toolbar may add, a second listener of any type fails, and `{ shortcut: false }` must
 * still reach zero — the original property remains available to anyone who wants it more than
 * they want the chord.
 *
 * Measured through CDP against the real listener registry, not a patched `addEventListener` —
 * patching the API under test would be the one thing this file exists to forbid.
 */

/** Every listener the toolbar is permitted to register on the host, and nothing else. */
const EXPECTED_LISTENERS = ["document:keydown"];
test.describe("host event surface", () => {
  async function listenerTypes(page: import("@playwright/test").Page): Promise<string[]> {
    const cdp = await page.context().newCDPSession(page);
    /* `DOMDebugger.getEventListeners` resolves against the DOM agent's node map. Without
       both domains enabled the call never returns rather than erroring. */
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    const found: string[] = [];
    try {
      for (const expression of ["window", "document"]) {
        const { result } = await cdp.send("Runtime.evaluate", { expression });
        if (!result.objectId) continue;
        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
          objectId: result.objectId,
          depth: 0,
        });
        for (const l of listeners) found.push(`${expression}:${l.type}`);
      }
    } finally {
      await cdp.detach();
    }
    return found.sort();
  }

  /**
   * Loads one arm and returns the listener types on `window` and `document`.
   *
   * `waitForFunction` is called in every arm, including the ones where the condition is
   * already true. Playwright installs its own polling instrumentation — a
   * `__playwright_global_listeners_check__` sentinel plus a set of pointer and mouse
   * listeners — the first time it polls, and those would otherwise show up as a difference
   * between the arms rather than as the test harness they are.
   */
  async function arm(
    page: import("@playwright/test").Page,
    query: string,
    settled: () => boolean,
  ): Promise<string[]> {
    await page.goto(`/?d0bar=${query}`, { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    await page.waitForFunction(settled);
    return listenerTypes(page);
  }

  /** What the running toolbar adds over the gated arm, which loads the same bundle inert. */
  function added(enabled: string[], gated: string[]): string[] {
    const baseline = [...gated];
    const extra: string[] = [];
    for (const type of enabled) {
      const at = baseline.indexOf(type);
      if (at === -1) extra.push(type);
      else baseline.splice(at, 1);
    }
    return extra.sort();
  }

  test("adds exactly the shortcut listener, and nothing else", async ({ page }) => {
    /* The gated arm loads the identical bundle and starts nothing, so the difference between
       the arms is precisely the listeners the running toolbar registers. */
    const gated = await arm(page, "gated", () => true);
    /* Waiting for the pill puts us past settle: if the toolbar were going to register
       anything, it has by now. */
    const enabled = await arm(page, "on", () => document.querySelector("d0-bar") !== null);

    expect(added(enabled, gated)).toEqual(EXPECTED_LISTENERS);
  });

  test("adds no listener at all when the shortcut is disabled", async ({ page }) => {
    const gated = await arm(page, "gated", () => true);
    const enabled = await arm(
      page,
      "on&shortcut=off",
      () => document.querySelector("d0-bar") !== null,
    );

    /* The zero-listener property is not gone, it is opt-in. A host that would rather have an
       untouched event surface than a keyboard shortcut can still have it. */
    expect(added(enabled, gated)).toEqual([]);
  });

  test("adds none after teardown either", async ({ page }) => {
    const gated = await arm(page, "gated", () => true);

    await arm(page, "on", () => document.querySelector("d0-bar") !== null);
    await page.evaluate(() =>
      (window as unknown as { D0bar: { destroy(): void } }).D0bar.destroy(),
    );

    /* A listener removed at teardown but balanced by one added elsewhere would pass a count
       comparison against the running state, so both states are compared to the same baseline.
       After teardown the shortcut is gone too — the budget returns to zero. */
    expect(added(await listenerTypes(page), gated)).toEqual([]);
  });
});

/**
 * Cache status comes from the browser where the browser will say.
 *
 * The fixture requests one `max-age` asset. Until it did, every response in the suite was
 * `no-store`, so the transfer-size heuristic and `deliveryType` agreed on 250 of 250 requests
 * purely because none of them was ever a hit — agreement that was not evidence of anything.
 *
 * The hit needs a second *navigation*, not a second `fetch` in the same document: a
 * same-document memory-cache hit emits no resource entry at all, and `reload()` revalidates
 * subresources by definition.
 */
test("reports a real cache hit through deliveryType", async ({ page }) => {
  const load = async () => {
    await page.evaluate(() => window.__fixtureReady);
    await page.evaluate(
      () => (window as unknown as { __cacheHitReady: Promise<void> }).__cacheHitReady,
    );
    return page.evaluate(() => {
      const hit = performance
        .getEntriesByType("resource")
        .find((e) => e.name.includes("cacheable.json")) as
        (PerformanceResourceTiming & { deliveryType?: string }) | undefined;
      return hit
        ? {
            deliveryType: hit.deliveryType,
            inferredCached: hit.transferSize === 0 && hit.encodedBodySize > 0,
          }
        : undefined;
    });
  };

  await page.goto("/?d0bar=off", { waitUntil: "load" });
  const first = await load();

  /* A fresh navigation, not `reload()`: a reload revalidates subresources by definition and
     would never produce a hit. */
  await page.goto("/?d0bar=off&second", { waitUntil: "load" });
  const second = await load();

  /* Cold, then warm. If the first were already a hit the assertion below would prove
     nothing about caching. */
  expect(first?.deliveryType).toBe("");
  expect(second?.deliveryType).toBe("cache");
  /* The heuristic happens to agree here. It is still the fallback, and still marked
     inferred — a 304 produces this same shape without being a cache hit. */
  expect(second?.inferredCached).toBe(true);
});
