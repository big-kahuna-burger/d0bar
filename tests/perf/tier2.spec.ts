import { expect, test } from "@playwright/test";

/**
 * Tier 2 in a real browser.
 *
 * The things asserted here cannot be reached from a unit test: a service worker only exists
 * in a browser, `workerStart` is a browser measurement, and the bug that made this change
 * necessary twice over — stage 1 and stage 2 being separate bundles with separate module
 * state — is invisible to a typechecker and to any test that imports the modules directly.
 * Both bundles were internally consistent while the footer said `2 SW off` about a worker
 * that was registered, active, and controlling the page.
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

/** The worker only controls the page from the *second* load — registration is post-settle. */
async function loadControlled(page: import("@playwright/test").Page, query = "?d0bar=on") {
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
}

async function readLog(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      /* No version. A reader has no business naming one: `open(name, n)` where `n` is below the
         existing version throws `VersionError`, so a hardcoded number here breaks every time the
         worker's schema moves — which is exactly what it did when the token store took the
         database to 2. Omitting it opens whatever version exists, which is what a reader wants
         and is the only form that cannot go stale. */
      const request = indexedDB.open("d0bar");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const tx = db.transaction("requests", "readonly");
      const query = tx.objectStore("requests").getAll();
      query.onsuccess = () => resolve(query.result as Array<Record<string, unknown>>);
      query.onerror = () => resolve([]);
    });
    db.close();
    return all;
  });
}

test.describe("registration", () => {
  test("claims the whole origin, not the directory the file sits in", async ({ page }) => {
    await loadControlled(page);

    const registration = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        count: regs.length,
        scope: regs[0]?.scope ?? null,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      };
    });

    expect(registration.count).toBe(1);
    /* The constraint, not a preference: a worker served from `/dist/` would control `/dist/`
       and see none of the page's traffic. The fixture serves it from the root for this
       reason, and a host has to do the same (or send `Service-Worker-Allowed`). */
    expect(registration.scope).toBe("http://127.0.0.1:8732/");
    expect(registration.controller).toContain("/d0bar-sw.js");
  });

  test("does not register during the load phase", async ({ page }) => {
    /* Registration is a network fetch plus an install event. Doing it while the host's LCP
       is still being decided would make the toolbar pay for tier 2 out of the page's budget,
       which is the one thing it must never do.

       Timed from inside the page rather than with `page.on("request")`: the worker script is
       fetched by the browser's service-worker machinery, not by the document, so it never
       appears as a page request and that listener fired zero times. Polling
       `getRegistration()` from an init script observes the thing itself. */
    await page.addInitScript(() => {
      const target = window as unknown as { __swAt?: number };
      const poll = setInterval(() => {
        void navigator.serviceWorker.getRegistration().then((registration) => {
          if (!registration) return;
          clearInterval(poll);
          target.__swAt ??= performance.now();
        });
      }, 10);
    });

    await page.goto("/?d0bar=on", { waitUntil: "load" });
    await page.waitForFunction(
      () => (window as unknown as { __swAt?: number }).__swAt !== undefined,
      undefined,
      { timeout: 15_000 },
    );

    const { registeredAt, loadEventEnd } = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return {
        registeredAt: (window as unknown as { __swAt: number }).__swAt,
        loadEventEnd: nav.loadEventEnd,
      };
    });

    expect(loadEventEnd).toBeGreaterThan(0);
    expect(
      registeredAt,
      `registration must not begin before the load event ends (load ${loadEventEnd.toFixed(1)}ms, registered ${registeredAt.toFixed(1)}ms)`,
    ).toBeGreaterThanOrEqual(loadEventEnd);
  });
});

test.describe("observation without interception", () => {
  test("adds no measurable worker-attributable delay", { tag: "@timing" }, async ({ page }) => {
    await loadControlled(page);

    const deltas = await page.evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((entry) => entry.workerStart !== 0)
        .map((entry) => entry.fetchStart - entry.workerStart)
        .sort((a, b) => a - b),
    );

    /* The task originally said "assert workerStart is 0". Measured, it is non-zero for every
       request once a worker controls the page — the field marks when service-worker handling
       *began*, whether or not the handler responds, so a pass-through worker and an
       intercepting one both stamp it. A zero assertion would only ever have passed on a page
       with no worker at all, which proves nothing about this one.
       
       What is actually claimable, and what the design says, is that the overhead is bounded
       and disclosed: the gap between `workerStart` and `fetchStart` is the worker's own
       dispatch cost. Measured across 250 requests on this fixture:

           p50 0.5ms   p90 3.3ms   p95 3.4ms   p99 3.5ms   max 3.6ms

       A tight tail, not a long one. The threshold is 5ms — above the measured maximum with
       headroom, low enough that a regression that doubled dispatch cost would fail.
       Deliberately p95 rather than the mean: a toolbar that is usually free and occasionally
       costs milliseconds is not free, and a mean hides exactly that.

       Note what this does *not* establish. It bounds service-worker dispatch, which any
       registered worker imposes; it does not attribute that cost to d0bar's handler versus
       the browser's own machinery. Separating those is `worker-perturbation.spec.ts`, which
       compares `?d0bar=on` against `?d0bar=on&sw=off` — the identical bundle and toolbar with
       and without a registration, so everything but the worker cancels. Measured across 1458
       requests per arm: p50 identical, p95 +1.6ms. */
    expect(deltas.length).toBeGreaterThan(0);
    const p95 = deltas[Math.floor(deltas.length * 0.95)] ?? 0;
    expect(
      p95,
      `p95 worker overhead was ${p95.toFixed(2)}ms across ${deltas.length} requests`,
    ).toBeLessThan(5);
  });

  test("logs the traceparent the page cannot see", async ({ page }) => {
    await loadControlled(page);
    await page.waitForFunction(async () => true);

    const log = await readLog(page);
    const traced = log.filter((record) => record["traceId"]);

    expect(log.length).toBeGreaterThan(0);
    /* The whole reason tier 2 exists: `PerformanceResourceTiming` exposes no request
       headers, so this trace id is unreachable from the page's own observers. */
    expect(traced.length).toBeGreaterThan(0);
    expect(traced[0]!["traceId"]).toMatch(/^[0-9a-f]{32}$/);
    expect(traced[0]!["spanId"]).toMatch(/^[0-9a-f]{16}$/);
  });

  test("records the method, which tier 1 never reports", async ({ page }) => {
    await loadControlled(page);
    const log = await readLog(page);
    expect(new Set(log.map((r) => r["method"]))).toContain("GET");
  });
});

test.describe("the log is durable", () => {
  test("survives a reload", async ({ page }) => {
    await loadControlled(page);
    const before = await readLog(page);
    expect(before.length).toBeGreaterThan(0);

    await page.reload({ waitUntil: "load" });

    const after = await readLog(page);
    /* The point of durability: the request that caused the error is still there after the
       refresh someone did to go looking for it. */
    const earliest = Math.min(...before.map((r) => Number(r["order"])));
    expect(after.some((r) => Number(r["order"]) === earliest)).toBe(true);
  });
});

test.describe("honest degradation", () => {
  test("reports tier 2 off, and says so in the label, when no worker is configured", async ({
    page,
  }) => {
    /* `?sw=off` is the `on` arm with tier 2 deliberately absent — the same bundle, the same
       toolbar, no worker path. This is the state a host with their own service worker lands
       in, and it must render as a real, explained state rather than a stub. */
    await page.goto("/?d0bar=on&sw=off", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    await page.waitForFunction(() => window.__d0root !== undefined);

    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
    await page.waitForFunction(
      () => window.__d0root!.querySelector('.tier[data-state="off"]') !== null,
    );

    const footer = await page.evaluate(() => {
      const root = window.__d0root!;
      /* The tooltip bubble is a descendant of the tier, so `textContent` returns the label
         with the entire explanation glued onto it. Strip the bubble before reading. */
      const labelOf = (tier: Element) => {
        const copy = tier.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".tip").forEach((bubble) => bubble.remove());
        return copy.textContent?.trim();
      };
      const tiers = [...root.querySelectorAll(".tier")].map((tier) => ({
        state: (tier as HTMLElement).dataset["state"],
        label: labelOf(tier),
      }));
      const perturb = root.querySelector(".perturb") as HTMLElement | null;
      return {
        tiers,
        perturb: perturb?.textContent?.trim(),
        perturbState: perturb?.dataset["state"],
      };
    });

    expect(footer.tiers[0]).toMatchObject({ state: "live" });
    /* The label carries the reading too, not just the dot colour — a screenshot, a
       monochrome display and a colour-blind reader all lose the dot. */
    expect(footer.tiers[1]).toMatchObject({ state: "off", label: "2 SW off" });
    expect(footer.tiers[2]?.state).toBe("planned");
    /* Tier 4 is built now, so `off` rather than `planned` — this page has no OpenTelemetry
       SDK, which is a state about the page, not about d0bar's backlog. Its own reasons are
       asserted in `otel.spec.ts`. */
    expect(footer.tiers[3]).toMatchObject({ state: "off", label: "4 OTel SDK off" });

    /* Degraded outranks the measurement: with no trace context there is no trace jump, and
       saying `Δ INP …` here would answer a question nobody can act on. */
    expect(footer.perturbState).toBe("degraded");
    expect(footer.perturb).toBe("degraded — no trace jump");
  });

  test("reports tier 2 live once the worker controls the page", async ({ page }) => {
    await loadControlled(page);
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
    await page.waitForFunction(
      () => window.__d0root!.querySelector('.tier[data-state="live"]:nth-child(2)') !== null,
      undefined,
      { timeout: 10_000 },
    );

    const footer = await page.evaluate(() => {
      const root = window.__d0root!;
      const tier2 = root.querySelectorAll(".tier")[1] as HTMLElement;
      const perturb = root.querySelector(".perturb") as HTMLElement;
      const copy = tier2.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".tip").forEach((bubble) => bubble.remove());
      return {
        state: tier2.dataset["state"],
        label: copy.textContent?.trim(),
        perturb: perturb.textContent?.trim(),
      };
    });

    /* The regression this exists for: both bundles typechecked and each was internally
       consistent while the panel read its own, never-written copy of the registration
       state and reported `off` for a live worker. */
    expect(footer.state).toBe("live");
    expect(footer.label).toBe("2 SW");
    /* Live tier 2 still does not licence a fabricated number: nothing has measured the
       toolbar's INP cost yet, so the slot says so. */
    expect(footer.perturb).toBe("Δ INP unavailable");
  });
});

test.describe("the host owns the scope", () => {
  /**
   * Outcome 3, against a real contended origin.
   *
   * `?sw=off` above covers a *different* state — no worker path configured — and the two are
   * only one dot apart in the footer while being completely different situations for the
   * developer reading it. One means "you did not serve the file"; this one means "your own
   * worker already owns this origin, and d0bar will not take it from you". A test that only
   * exercised the first would leave the sentence that actually explains this case unasserted.
   *
   * The fixture registers `/host-sw.js` — a worker that knows nothing about d0bar and has no
   * `fetch` handler at all — before the bundle loads, and claims the page on activate so the
   * contention exists on the first load rather than the second.
   */
  test("renders the whole degraded path, and names the reason", async ({ page }) => {
    await page.goto("/?d0bar=on&hostsw=1", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    /* The host's worker has to have taken the scope before d0bar looks, or the test is
       measuring the uncontended path under a contended name. */
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.active?.scriptURL.endsWith("/host-sw.js"));
    });
    await page.waitForFunction(() => window.__d0root !== undefined);

    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
    await page.waitForFunction(
      () => window.__d0root!.querySelector('.tier[data-state="off"]') !== null,
    );

    const footer = await page.evaluate(() => {
      const root = window.__d0root!;
      const labelOf = (tier: Element) => {
        const copy = tier.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".tip").forEach((bubble) => bubble.remove());
        return copy.textContent?.trim();
      };
      const tiers = [...root.querySelectorAll(".tier")].map((tier) => ({
        state: (tier as HTMLElement).dataset["state"],
        label: labelOf(tier),
        detail: tier.querySelector(".tip")?.textContent?.trim() ?? "",
      }));
      const perturb = root.querySelector(".perturb") as HTMLElement | null;
      return {
        tiers,
        perturb: perturb?.textContent?.trim(),
        perturbState: perturb?.dataset["state"],
      };
    });

    expect(footer.tiers[0]).toMatchObject({ state: "live" });
    expect(footer.tiers[1]).toMatchObject({ state: "off", label: "2 SW off" });

    /* The reason, not just the state. This is the assertion that separates this test from the
       `?sw=off` one, and the sentence is the whole product of the degraded path: it says the
       scope belongs to the host, that d0bar will not take it, and what the developer can do
       instead. It must never be replaced by a guess at a cause. */
    expect(footer.tiers[1]?.detail).toContain("belongs to the host page");
    expect(footer.tiers[1]?.detail).toContain(
      "never takes or unregisters someone else's scope",
    );
    expect(footer.tiers[1]?.detail).toContain("import d0bar's worker module");
    expect(
      footer.tiers[1]?.detail,
      "the no-worker-path copy leaked into the contended state",
    ).not.toContain("No worker path is configured");

    expect(footer.perturbState).toBe("degraded");
    expect(footer.perturb).toBe("degraded — no trace jump");
  });

  test("every request resolves to the no-span state, and no global is patched", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "__pristineFetch", { value: window.fetch });
      Object.defineProperty(window, "__pristineOpen", { value: XMLHttpRequest.prototype.open });
    });

    await page.goto("/?d0bar=on&hostsw=1", { waitUntil: "load" });
    await page.evaluate(() => window.__fixtureReady);
    await page.waitForFunction(() => window.__d0root !== undefined);
    await page.locator("d0-bar").click();
    await page.waitForFunction(
      () => (window.__d0root!.querySelectorAll(".row").length ?? 0) > 0,
    );

    const reading = await page.evaluate(() => {
      const root = window.__d0root!;
      const chips = [...root.querySelectorAll(".row")]
        .map((row) => row.querySelector(".col-trace .chip")?.textContent?.trim())
        .filter((text): text is string => typeof text === "string" && text.length > 0);
      return {
        chips,
        traced: chips.filter((text) => text === "TRACE").length,
        /* The rejected alternative, asserted absent. Patching `fetch` is what every other
           toolbar does when the scope is unavailable, and it is exactly what must not happen
           here — the degraded state is the answer, not a problem to route around. */
        fetchPristine:
          window.fetch === (window as unknown as { __pristineFetch: unknown }).__pristineFetch,
        openPristine:
          XMLHttpRequest.prototype.open ===
          (window as unknown as { __pristineOpen: unknown }).__pristineOpen,
        fetchNative: Function.prototype.toString.call(window.fetch).includes("[native code]"),
      };
    });

    expect(
      reading.chips.length,
      "no rows rendered, so nothing was actually asserted",
    ).toBeGreaterThan(0);
    /* With no worker there is no traceparent to read, so no request can be shown as traced.
       A single `TRACE` chip here would mean the panel is claiming trace context it never saw. */
    expect(reading.traced).toBe(0);
    expect(reading.fetchPristine).toBe(true);
    expect(reading.openPristine).toBe(true);
    expect(reading.fetchNative).toBe(true);
  });
});
