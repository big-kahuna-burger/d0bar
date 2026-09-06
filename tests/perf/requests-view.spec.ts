import { expect, test } from "@playwright/test";
import { attributedDuring, isD0bar } from "./attribution";

/** The spec's frame budget: no frame carries more than this much toolbar work. */
const FRAME_BUDGET_MS = 8;

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

/**
 * Waits until the list stops growing on its own, and returns the count it settled at.
 *
 * The fixture issues 300 requests in a burst plus a pumped tail, and `openPanel` returns as
 * soon as the first row exists — so a baseline read there is a moving number. Any assertion
 * about d0bar's own streaming has to start from a still one.
 */
async function quiet(page: import("@playwright/test").Page): Promise<number> {
  const records = () =>
    page.evaluate(() => {
      const spacer = window.__d0root!.querySelector(".rows-spacer") as HTMLElement;
      return Math.round(parseFloat(spacer.style.height) / 21);
    });
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const now = await records();
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(250);
  }
  return last;
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
    await quiet(page);

    const before = await page.evaluate(() => window.__d0root!.querySelectorAll(".row").length);

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

  test("scrolling the full list costs no long frame", { tag: "@timing" }, async ({ page }) => {
    await openPanel(page);
    await quiet(page);

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

    /* The coarse half of the budget: no frame in the window exceeded 50 ms, whoever ran in
       it. The toolbar's own share is measured separately below — this entry covers the whole
       frame and has a 50 ms floor, so it can neither see an 8 ms budget nor say whose the
       work was. */
    const long = (frames ?? []).filter((duration) => duration > 50);
    expect(
      long,
      `long animation frames during a full scroll: ${JSON.stringify(frames)}`,
    ).toHaveLength(0);
  });

  /**
   * The spec's actual number: *no frame with more than 8 ms of toolbar work*.
   *
   * Read out of the browser's own tracer, per top-level task, attributed by script URL — see
   * `attribution.ts` for why neither `long-animation-frame` nor `longtask` can answer this and
   * why in-product timing is not an option. What the earlier note here said — that attributing
   * the cost needs `add-self-attribution` — was true of the two performance-entry instruments
   * and not of CDP, which has carried `FunctionCall.args.data.url` all along.
   *
   * Two records, because they answer two questions: `maxTaskMs` is d0bar's script time in the
   * worst task and is what the budget gates; `maxAnyTaskMs` is that task-vs-any-task context,
   * reported so a regression in the gap between them is visible rather than silent.
   */
  test(
    "spends under 8 ms of toolbar time in any frame of a full scroll",
    { tag: "@timing" },
    async ({ page }) => {
      await openPanel(page);
      await quiet(page);

      const attributed = await attributedDuring(page, isD0bar, async () => {
        await page.evaluate(async () => {
          const scroll = window.__d0root!.querySelector(".rows-scroll") as HTMLElement;
          const max = scroll.scrollHeight - scroll.clientHeight;
          for (let pass = 0; pass < 3; pass += 1) {
            for (let offset = 0; offset <= max; offset += 21) {
              scroll.scrollTop = offset;
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
          }
        });
      });

      /* A scroll that attributed nothing to d0bar measured nothing at all — the tracing
       category could have changed name, or the bundle URL could have. Fail rather than pass
       a budget on an empty set. */
      expect(
        attributed.totalMs,
        "no d0bar script was attributed during the scroll — the instrument, not the toolbar",
      ).toBeGreaterThan(0);

      /* Recorded rather than only printed on failure: `bench/last-run.json` is the run's own
       record, and a budget row in `bench/budget.json` has to come from a number someone can
       find again. */
      test.info().annotations.push({
        type: "d0bar-scroll",
        description:
          `max ${attributed.maxTaskMs.toFixed(2)} ms in one frame, ` +
          `${attributed.totalMs.toFixed(1)} ms total over ${attributed.taskMs.length} frames, ` +
          `longest task of any origin ${attributed.maxAnyTaskMs.toFixed(2)} ms`,
      });

      expect(
        attributed.maxTaskMs,
        `worst frame's d0bar work ${attributed.maxTaskMs.toFixed(2)} ms; ` +
          `top frames ${JSON.stringify(attributed.taskMs.slice(0, 5).map((ms) => +ms.toFixed(2)))}; ` +
          `longest task of any origin ${attributed.maxAnyTaskMs.toFixed(2)} ms`,
      ).toBeLessThan(FRAME_BUDGET_MS);
    },
  );
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
  /**
   * The list streams at all.
   *
   * This is the property that regressed silently and was not caught, because the test below
   * samples its baseline while the fixture's own 300-request storm is still landing — so its
   * `after > before` passed on the fixture arriving, and would have passed identically with
   * live updates entirely dead. They *were* entirely dead: `onResourceBatch` held one listener
   * slot and two views registered for it, so the untraced view's registration overwrote the
   * requests view's and the list showed whatever the ring held when the panel opened.
   *
   * So this waits for the page to go quiet first, and only then issues requests. Every number
   * it asserts is a delta against a baseline nothing else is moving.
   */
  test("keeps appending after the page has gone quiet", async ({ page }) => {
    await openPanel(page);
    const settled = await quiet(page);

    await page.evaluate(async () => {
      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < 20; i += 1) {
        pending.push(fetch(`/api/resource?quiet=${i}&delay=5`).then((r) => r.text()));
      }
      await Promise.all(pending);
    });

    await page.waitForFunction(
      (baseline) => {
        const spacer = window.__d0root!.querySelector(".rows-spacer") as HTMLElement;
        return Math.round(parseFloat(spacer.style.height) / 21) >= baseline + 20;
      },
      settled,
      { timeout: 10_000 },
    );
  });

  /**
   * The append storm: 300 requests over 3 s with the panel open, watching the list.
   *
   * The scroll bench measures the list being read. This measures it being written to — which
   * is the state a developer actually leaves the panel in, and the one where the toolbar's
   * cost lands on a page that is itself doing work. One request every 10 ms is faster than
   * any real page sustains and crosses the ring's 512 capacity partway through, so eviction
   * and the index shift it forces are inside the measured window rather than outside it.
   *
   * Only measurable at all since the `onResourceBatch` listener slot became a list: before
   * that, an open list received no appends, and this bench would have measured a static view.
   */
  test(
    "spends under 8 ms of toolbar time in any frame of an append storm",
    { tag: "@timing" },
    async ({ page }) => {
      await openPanel(page);
      const settled = await quiet(page);

      const attributed = await attributedDuring(page, isD0bar, async () => {
        await page.evaluate(async () => {
          const pending: Array<Promise<unknown>> = [];
          for (let i = 0; i < 300; i += 1) {
            pending.push(fetch(`/api/resource?storm=${i}&delay=5`).then((r) => r.text()));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await Promise.all(pending);
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
      });

      const after = await page.evaluate(() => {
        const root = window.__d0root!;
        const spacer = root.querySelector(".rows-spacer") as HTMLElement;
        return {
          records: Math.round(parseFloat(spacer.style.height) / 21),
          rows: root.querySelectorAll(".row:not([hidden])").length,
          dropped: (root.querySelector(".rows-dropped") as HTMLElement).hidden,
        };
      });

      /* The storm landed. Without this the budget below would pass on a list nothing appended
       to — which is exactly how the regression this bench now covers went unnoticed. */
      expect(after.records, `list held ${settled} before the storm`).toBeGreaterThan(settled);
      /* Past capacity, so eviction ran and said so. */
      expect(after.records).toBe(512);
      expect(after.dropped, "records were evicted and the list did not report it").toBe(false);
      /* And the window is still a window — 300 appends did not grow the row pool. */
      expect(after.rows).toBeLessThanOrEqual(27);

      /* Recorded rather than only printed on failure: `bench/last-run.json` is the run's own
       record, and a budget row in `bench/budget.json` has to come from a number someone can
       find again. */
      test.info().annotations.push({
        type: "d0bar-append-storm",
        description:
          `max ${attributed.maxTaskMs.toFixed(2)} ms in one frame, ` +
          `${attributed.totalMs.toFixed(1)} ms total over ${attributed.taskMs.length} frames, ` +
          `longest task of any origin ${attributed.maxAnyTaskMs.toFixed(2)} ms`,
      });

      expect(
        attributed.maxTaskMs,
        `worst frame's d0bar work ${attributed.maxTaskMs.toFixed(2)} ms; ` +
          `top frames ${JSON.stringify(attributed.taskMs.slice(0, 5).map((ms) => +ms.toFixed(2)))}; ` +
          `${attributed.totalMs.toFixed(1)} ms total over ${attributed.taskMs.length} frames`,
      ).toBeLessThan(FRAME_BUDGET_MS);
    },
  );

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
    const focused = await page.evaluate(() => window.__d0root!.activeElement?.className ?? "");
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
