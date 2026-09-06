import { expect, test } from "@playwright/test";

/**
 * The requests view in a real browser.
 *
 * What only a browser can settle: that the row count stays proportional to the viewport when
 * the ring is full, that a drag through the list costs no long frame, that appends do not
 * move the viewport, and that the waterfall's geometry really does arrive as two custom
 * properties rather than as a JavaScript layout calculation.
 *
 * The unit tests settle the arithmetic. This settles the cost.
 */

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
    __d0root: ShadowRoot | undefined;
  }
}

test.beforeEach(async ({ page }) => {
  /* The pill's shadow root is closed, deliberately — the host page must not be able to reach
     into the toolbar. Opening it for the test is done at the platform level, before d0bar
     runs, rather than by weakening the product. */
  await page.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const root = original.call(this, { ...init, mode: "open" });
      if (this.tagName === "D0-BAR") window.__d0root = root;
      return root;
    };
  });
});

async function openPanel(page: import("@playwright/test").Page, query = "?d0bar=on") {
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => window.__d0root !== undefined);
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
  await page.waitForFunction(() => window.__d0root!.querySelector(".row") !== null, undefined, {
    timeout: 15_000,
  });
}

test.describe("windowing", () => {
  test("keeps the row count proportional to the viewport, not to the record count", async ({
    page,
  }) => {
    await openPanel(page);

    const measured = await page.evaluate(() => {
      const root = window.__d0root!;
      const spacer = root.querySelector(".rows-spacer") as HTMLElement;
      return {
        rows: root.querySelectorAll(".row").length,
        /* The spacer carries the full extent, so this is the record count the list claims
           to be showing — the number the row count must stay independent of. */
        records: Math.round(parseFloat(spacer.style.height) / 21),
      };
    });

    /* The fixture issues 300 requests plus the page's own, so the ring is at capacity. */
    expect(measured.records).toBeGreaterThan(200);
    /* Viewport (288px / 21px = 14, +1 partial) plus 6 rows of overscan either side. */
    expect(
      measured.rows,
      `${measured.rows} row elements for ${measured.records} records`,
    ).toBeLessThanOrEqual(27);
  });

  test("creates no new rows while scrolling the whole list", async ({ page }) => {
    await openPanel(page);

    const before = await page.evaluate(
      () => window.__d0root!.querySelectorAll(".row").length,
    );

    await page.evaluate(async () => {
      const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
      const max = scroll.scrollHeight - scroll.clientHeight;
      for (let offset = 0; offset <= max; offset += 42) {
        scroll.scrollTop = offset;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });

    const after = await page.evaluate(() => window.__d0root!.querySelectorAll(".row").length);
    /* The pool grows once, to the widest window, and never again. */
    expect(after).toBeLessThanOrEqual(27);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("scrolling the full list costs no long frame", async ({ page }) => {
    await openPanel(page);

    const frames = await page.evaluate(async () => {
      const durations: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) durations.push(entry.duration);
      });
      try {
        observer.observe({ type: "long-animation-frame", buffered: false });
      } catch {
        return null;
      }

      const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
      const max = scroll.scrollHeight - scroll.clientHeight;
      for (let pass = 0; pass < 3; pass += 1) {
        for (let offset = 0; offset <= max; offset += 21) {
          scroll.scrollTop = offset;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      observer.disconnect();
      return durations;
    });

    test.skip(frames === null, "long-animation-frame unsupported on this browser");

    /* Note what this measures and what it does not. A long-animation-frame entry covers the
       whole frame, not d0bar's share of it — attributing the cost to the toolbar
       specifically needs script attribution, which arrives with add-self-attribution. The
       fixture is idle by this point (its request storm is long finished and it schedules no
       further work), so a long frame here is the list's, but that is an argument from the
       fixture's behaviour rather than a measurement of provenance. */
    const long = (frames ?? []).filter((duration) => duration > 50);
    expect(
      long,
      `long animation frames during a full scroll: ${JSON.stringify(frames)}`,
    ).toHaveLength(0);
  });
});

test.describe("bar geometry", () => {
  test("arrives as two custom properties on the row", async ({ page }) => {
    await openPanel(page);

    const geometry = await page.evaluate(() => {
      const rows = [...window.__d0root!.querySelectorAll<HTMLElement>(".row")];
      return rows.slice(0, 5).map((row) => ({
        l: row.style.getPropertyValue("--l"),
        w: row.style.getPropertyValue("--w"),
        /* The computed width proves the browser did the arithmetic from the properties —
           if the row wrote pixels itself, this would be true of a different mechanism. */
        barWidth: (row.querySelector(".bar") as HTMLElement).getBoundingClientRect().width,
      }));
    });

    for (const row of geometry) {
      expect(row.l).not.toBe("");
      expect(row.w).not.toBe("");
      expect(Number(row.l)).toBeGreaterThanOrEqual(0);
      expect(row.barWidth).toBeGreaterThan(0);
    }
  });

  test("draws an undifferentiated bar where the browser reported no phases", async ({
    page,
  }) => {
    await openPanel(page);

    const kinds = await page.evaluate(() => {
      const rows = [...window.__d0root!.querySelectorAll<HTMLElement>(".row")];
      const out = { measured: 0, none: 0 };
      for (const row of rows) {
        const bar = row.querySelector(".bar") as HTMLElement;
        if (bar.dataset["phases"] === "measured") out.measured += 1;
        else out.none += 1;
      }
      return out;
    });

    /* The fixture issues one request in five to a second hostname served without
       Timing-Allow-Origin, so both states are reachable on the same page and neither
       assertion can pass by the other never occurring. */
    expect(kinds.measured).toBeGreaterThan(0);
    expect(kinds.none).toBeGreaterThan(0);
  });
});

test.describe("streaming", () => {
  /* The eviction half of this requirement — records falling off the front of a full ring,
     which shifts every retained index and must move the offset and the selection with them —
     is settled in `tests/unit/requests-view.test.ts` against a capacity-8 fake ring. It is
     not reachable here: the fixture issues ~310 requests against a ring that holds 512, and
     driving 200 more just to reach the boundary would change the traffic shape the rest of
     this file measures. */
  test("appending does not move the viewport or drop the selection", async ({ page }) => {
    await openPanel(page);

    /* Scrolled and read in its own step. Selecting a row pushes the trace surface, which
       hides the list — and `display: none` discards `scrollTop` on the spot, so an offset
       read after the click is always zero and would make this assertion pass for the wrong
       reason. This is also the ordering a person produces: scroll, then click. */
    const before = await page.evaluate(() => {
      const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
      const spacer = window.__d0root!.querySelector(".rows-spacer") as HTMLElement;
      scroll.scrollTop = 40 * 21;
      return {
        scrollTop: scroll.scrollTop,
        records: Math.round(parseFloat(spacer.style.height) / 21),
      };
    });
    expect(before.scrollTop).toBe(40 * 21);

    const label = await page.evaluate(() => {
      const row = window.__d0root!.querySelectorAll<HTMLElement>(".row")[3]!;
      const name = row.getAttribute("aria-label");
      row.click();
      return name;
    });

    /* Back to the list. The offset has to survive the round trip, which is what the view's
       own `rememberScroll` on the way out is for. */
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__d0root!.querySelector(".row") !== null);
    await page.waitForFunction(
      (expected) => {
        const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
        return scroll.scrollTop === expected;
      },
      40 * 21,
      { timeout: 5_000 },
    );

    /* Ten more requests, issued the way the fixture issues its own. */
    await page.evaluate(async () => {
      const gets: Array<Promise<unknown>> = [];
      for (let i = 0; i < 10; i += 1) {
        gets.push(fetch(`/api/resource?late=${i}&delay=5`).then((r) => r.text()));
      }
      await Promise.all(gets);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const after = await page.evaluate(() => {
      const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
      const spacer = window.__d0root!.querySelector(".rows-spacer") as HTMLElement;
      return {
        scrollTop: scroll.scrollTop,
        records: Math.round(parseFloat(spacer.style.height) / 21),
      };
    });

    expect(label).not.toBeNull();
    /* The fixture produces roughly 310 records against a ring that holds 512, so nothing was
       evicted: the ten arrivals appended below the viewport and every row already on screen
       kept its index. The requirement is then exactly that the offset does not move — the
       user reads the same rows they were reading. */
    expect(after.records).toBeLessThan(512);
    expect(after.records).toBeGreaterThan(before.records);
    expect(after.scrollTop).toBe(before.scrollTop);
  });
});

test.describe("keyboard", () => {
  test("gives the list one tab stop and opens a row with Enter", async ({ page }) => {
    await openPanel(page);

    const stops = await page.evaluate(
      () => window.__d0root!.querySelectorAll('.row[tabindex="0"]').length,
    );
    expect(stops).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const row = window.__d0root!.querySelectorAll<HTMLElement>(".row")[2]!;
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    /* The list gives way to the trace surface. Asserted against the surface itself now that
       `add-trace-view` has landed — this test used to assert its placeholder copy. */
    await page.waitForFunction(() => {
      const requests = window.__d0root!.querySelector(".requests") as HTMLElement;
      const trace = window.__d0root!.querySelector(".trace") as HTMLElement;
      return requests.hidden && !trace.hidden;
    });

    /* And focus goes with it. Escape is bound on the panel element and never on the host's
       document, so it only fires while focus is inside the panel; the row that had focus is
       now hidden, which drops focus to `<body>` and silently breaks Escape. Observed in
       Chromium before it was fixed, which is why it is asserted here rather than trusted. */
    const focused = await page.evaluate(
      () => window.__d0root!.activeElement?.className ?? "",
    );
    expect(focused).toContain("trace-back");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const requests = window.__d0root!.querySelector(".requests") as HTMLElement;
      return !requests.hidden;
    });
  });

  test("names every row for a screen reader", async ({ page }) => {
    await openPanel(page);

    const labels = await page.evaluate(() =>
      [...window.__d0root!.querySelectorAll(".row")]
        .slice(0, 10)
        .map((row) => row.getAttribute("aria-label")),
    );

    for (const label of labels) {
      expect(label).toBeTruthy();
      /* Four commas: method, path, status, duration, trace state — including the absences,
         which are spelled out rather than omitted. */
      expect(label!.split(", ").length).toBe(5);
    }
  });
});
