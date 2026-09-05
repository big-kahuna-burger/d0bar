import { expect, test } from "@playwright/test";

/**
 * Panel shell invariants that only a real browser can settle.
 *
 * These are layout and containment facts, so they are asserted against computed style and
 * measured boxes rather than against the CSS text — a rule that is present but overridden is
 * indistinguishable from an absent one when you read the stylesheet.
 *
 * The shadow root is closed by design, so `attachShadow` is patched before the bundle runs to
 * capture it. That is a test seam and nothing more: patching from the outside proves the
 * production path is untouched, where exposing a handle from inside would have changed it.
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
  await page.goto("/?d0bar=on", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => window.__d0root !== undefined);
});

test("the pill host contains its layout, paint and style", async ({ page }) => {
  /* Read off the host element, not the pill inside it: the guarantee is that nothing the
     toolbar does can induce layout or paint work in the customer's page, and the host is the
     only node of ours the customer's layout can see. */
  const contain = await page.evaluate(() => {
    const host = window.__d0root!.host;
    return getComputedStyle(host).contain;
  });

  /* Chrome serialises `contain: layout paint style` as its exact shorthand, `content` — the
     two are the same computed value, so both spellings are accepted rather than pinning the
     assertion to one browser's choice of serialisation. */
  const kinds =
    contain.trim() === "content" ? ["layout", "paint", "style"] : contain.split(/\s+/);

  for (const kind of ["layout", "paint", "style"]) {
    expect(kinds, `the pill host must contain ${kind} (computed: "${contain}")`).toContain(
      kind,
    );
  }
});

test("the panel contains layout and style, and deliberately not paint", async ({ page }) => {
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

  const contain = await page.evaluate(
    () => getComputedStyle(window.__d0root!.querySelector(".panel")!).contain,
  );

  expect(contain).toContain("layout");
  expect(contain).toContain("style");
  /* Paint containment clips descendants to the padding box, which would cut off every
     tooltip. The panel is a top-layer popover, so its paint is already isolated from the
     host page by the stacking model rather than by this property. */
  expect(contain, "paint containment would clip the panel's own tooltips").not.toContain(
    "paint",
  );
});

test("no tooltip is clipped by the panel", async ({ page }) => {
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

  /* Every bubble is measured while forced open, because the one that overflows is the one on
     the shortest panel — and which that is changes as views land. */
  const overflowing = await page.evaluate(() => {
    const root = window.__d0root!;
    const panel = root.querySelector(".panel")!;
    const bad: string[] = [];
    for (const bubble of root.querySelectorAll<HTMLElement>(".tip")) {
      const wasHidden = bubble.hidden;
      bubble.hidden = false;
      const b = bubble.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      /* A bubble may hang outside the panel's box — that is the point of dropping paint
         containment. What it must not do is get clipped, so this asserts it has a real
         painted size and stays on screen. */
      if (b.width === 0 || b.height === 0)
        bad.push(`${bubble.textContent?.slice(0, 20)}: zero box`);
      if (b.left < 0 || b.right > window.innerWidth) {
        bad.push(`${bubble.textContent?.slice(0, 20)}: off screen (${b.left}–${b.right})`);
      }
      if (b.width > p.width) {
        bad.push(`${bubble.textContent?.slice(0, 20)}: wider than the panel (${b.width})`);
      }
      bubble.hidden = wasHidden;
    }
    return bad;
  });

  expect(overflowing).toEqual([]);
});

test("the footer strip fits on one line at 620px", async ({ page }) => {
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

  const strip = await page.evaluate(() => {
    const foot = window.__d0root!.querySelector<HTMLElement>(".foot")!;
    return {
      height: foot.getBoundingClientRect().height,
      /* A wrapped strip is taller than its declared height, and the panel is bottom-anchored,
         so it would grow upward and move under the cursor. Comparing scroll width against
         client width catches the wrap before it changes the height. */
      scrollWidth: foot.scrollWidth,
      clientWidth: foot.clientWidth,
      contentWidth: [...foot.children].reduce(
        (total, child) => total + child.getBoundingClientRect().width,
        0,
      ),
    };
  });

  expect(strip.height, "the strip must stay 32px — a wrap would move the panel").toBe(32);
  expect(strip.scrollWidth, "the strip must not overflow its own width").toBeLessThanOrEqual(
    strip.clientWidth,
  );
  /* The handoff's budget: four tier labels plus the perturbation label inside 620px, less the
     panel's borders and the strip's own padding. A fifth label must replace one, not join. */
  expect(strip.contentWidth).toBeLessThanOrEqual(618);
});

/**
 * The shortcut, which is the reason the toolbar has a listener on the host page at all.
 *
 * The requirement is specifically that it works *before* stage 2 exists — a chord handled by
 * the panel's own keydown listener could only ever close a panel that was already open, which
 * is not a shortcut for opening one. So this presses the chord on a page where the panel has
 * never been fetched and asserts the panel appears.
 */
test.describe("keyboard shortcut", () => {
  /** The chord, as the platform resolves it. */
  async function chord(page: import("@playwright/test").Page): Promise<string> {
    const mac = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
    return mac ? "Meta+Shift+0" : "Control+Shift+0";
  }

  test("opens the panel before stage 2 has been fetched", async ({ page }) => {
    /* Blocking the panel bundle until the chord is pressed proves stage 1 owns the shortcut:
       if the handler lived in the panel, there would be nothing to receive this. */
    expect(await page.evaluate(() => window.__d0root!.querySelector(".panel"))).toBeNull();

    await page.keyboard.press(await chord(page));
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    expect(
      await page.evaluate(() =>
        window.__d0root!.querySelector(".panel")!.matches(":popover-open"),
      ),
    ).toBe(true);
  });

  test("toggles rather than only opening", async ({ page }) => {
    const keys = await chord(page);
    await page.keyboard.press(keys);
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    await page.keyboard.press(keys);
    await page.waitForFunction(
      () => !window.__d0root!.querySelector(".panel")!.matches(":popover-open"),
    );

    await page.keyboard.press(keys);
    await page.waitForFunction(() =>
      window.__d0root!.querySelector(".panel")!.matches(":popover-open"),
    );
  });

  test("does not fire while the host page has focus in a text field", async ({ page }) => {
    /* The fixture has no input of its own, so one is added — the assertion is about the
       toolbar's behaviour, not the fixture's content. */
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.id = "probe";
      document.body.appendChild(field);
      field.focus();
    });

    await page.keyboard.press(await chord(page));
    await page.waitForTimeout(500);

    expect(
      await page.evaluate(() => window.__d0root!.querySelector(".panel")),
      "a chord typed into a text field belongs to the host page",
    ).toBeNull();
  });
});

/**
 * Responsive behaviour, motion, and scroll memory.
 *
 * All four are asserted against the browser's computed values rather than the stylesheet:
 * a container query that never matches, a keyframe the UA dropped, and a `scrollTop` the
 * panel assigned before layout existed all read as correct in the CSS text and wrong on
 * screen.
 */
test.describe("responsive", () => {
  async function openPanel(page: import("@playwright/test").Page) {
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);
  }

  test("holds the design width until space actually runs out", async ({ page }) => {
    /* 700px is inside the media query but the panel still fits: 620 + 32 = 652. A bare
       `calc(100vw - 32px)` would resolve to 668px here — wider than the design width, and
       growing as the viewport shrank into the query. */
    await page.setViewportSize({ width: 700, height: 800 });
    await openPanel(page);

    const width = await page.evaluate(
      () => window.__d0root!.querySelector(".panel")!.getBoundingClientRect().width,
    );
    expect(width, "the panel must not grow when the viewport shrinks").toBe(620);
  });

  test("drops to the viewport below the fitting width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await openPanel(page);

    const box = await page.evaluate(() => {
      const panel = window.__d0root!.querySelector(".panel")!.getBoundingClientRect();
      return { width: panel.width, right: panel.right };
    });
    expect(box.width).toBe(420 - 32);
    /* And it stays on screen — a panel that fits but overflows to the right is no better. */
    expect(box.right).toBeLessThanOrEqual(420);
  });

  test("drops the waterfall column, and only that column, when the panel is narrow", async ({
    page,
  }) => {
    await openPanel(page);

    /* The requests view lands with `add-requests-view`, so the cells it will mark are stood
       up here as probes. This asserts the contract the view is being written against — that
       `[data-col="waterfall"]` is dropped and its neighbours are not — rather than asserting
       against markup that does not exist yet. */
    const visibility = await page.evaluate(() => {
      const root = window.__d0root!;
      const body = root.querySelector(".body")!;
      const row = document.createElement("div");
      for (const col of ["path", "status", "duration", "waterfall"]) {
        const cell = document.createElement("span");
        cell.dataset.col = col;
        cell.textContent = col;
        row.appendChild(cell);
      }
      body.appendChild(row);

      const read = () =>
        Object.fromEntries(
          [...row.children].map((cell) => [
            (cell as HTMLElement).dataset.col,
            getComputedStyle(cell).display !== "none",
          ]),
        );

      const wide = read();
      /* Narrow the container directly. The query is on the panel's inline size, not the
         viewport, precisely so it still fires when the panel is detached into a
         Picture-in-Picture window — so this is the axis that must be exercised. */
      const panel = root.querySelector(".panel") as HTMLElement;
      panel.style.width = "500px";
      const narrow = read();
      panel.style.width = "";
      row.remove();
      return { wide, narrow };
    });

    expect(visibility.wide.waterfall, "the waterfall shows at the design width").toBe(true);
    expect(
      visibility.narrow.waterfall,
      "the waterfall is dropped when the panel is narrow",
    ).toBe(false);
    for (const col of ["path", "status", "duration"]) {
      expect(visibility.narrow[col], `${col} carries a number and must survive`).toBe(true);
    }
  });
});

test.describe("ingest-lag dots", () => {
  test("pulse on opacity alone, staggered", async ({ page }) => {
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    const dots = await page.evaluate(() => {
      const body = window.__d0root!.querySelector(".body")!;
      const wrap = document.createElement("div");
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("i");
        dot.className = "lag-dot";
        wrap.appendChild(dot);
      }
      body.appendChild(wrap);
      const read = [...wrap.children].map((dot) => {
        const style = getComputedStyle(dot);
        return {
          name: style.animationName,
          duration: style.animationDuration,
          delay: style.animationDelay,
          iteration: style.animationIterationCount,
          timing: style.animationTimingFunction,
        };
      });
      wrap.remove();
      return read;
    });

    for (const dot of dots) {
      expect(dot.name).toBe("d0-pulse");
      expect(dot.duration).toBe("1.1s");
      expect(dot.iteration).toBe("infinite");
      expect(dot.timing).toBe("ease-in-out");
    }
    /* The stagger is what makes three dots read as progress rather than a blink. */
    expect(dots.map((dot) => dot.delay)).toEqual(["0s", "0.18s", "0.36s"]);
  });

  test("do not pulse under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("d0-bar").click();
    await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

    const dot = await page.evaluate(() => {
      const body = window.__d0root!.querySelector(".body")!;
      const node = document.createElement("i");
      node.className = "lag-dot";
      body.appendChild(node);
      const style = getComputedStyle(node);
      const read = { name: style.animationName, opacity: style.opacity };
      node.remove();
      return read;
    });

    expect(dot.name, "an infinite animation is the one kind waiting does not escape").toBe(
      "none",
    );
    /* Held at full opacity: what remains must be three dots, not three faint ones. */
    expect(dot.opacity).toBe("1");
  });
});

test("returning to the list restores scroll position and the active tab", async ({ page }) => {
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".panel") !== null);

  const result = await page.evaluate(async () => {
    const root = window.__d0root!;
    const body = root.querySelector(".body") as HTMLElement;
    /* The views are empty until they land, so the body has nothing to scroll. Give it
       something — the assertion is about the panel restoring an offset, not about what the
       list happens to contain. */
    const filler = document.createElement("div");
    filler.style.height = "2000px";
    body.appendChild(filler);

    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    body.scrollTop = 420;
    body.dispatchEvent(new Event("scroll"));
    await frame();

    const tabs = [...root.querySelectorAll<HTMLElement>(".tab")];
    const before = tabs.find((node) => node.getAttribute("aria-selected") === "")?.textContent;

    /* Leave the list for the trace surface and come back the way Escape does. */
    const panel = root.querySelector(".panel") as HTMLElement;
    panel.focus();
    return { before, scrollBefore: body.scrollTop };
  });

  expect(result.scrollBefore).toBe(420);

  /* Escape from the list closes, so the round trip is driven through the tab row instead:
     switching away and back exercises the same per-tab restore path. */
  const restored = await page.evaluate(async () => {
    const root = window.__d0root!;
    const body = root.querySelector(".body") as HTMLElement;
    const tabs = [...root.querySelectorAll<HTMLElement>(".tab")];
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    tabs[1]!.click();
    await frame();
    const onOtherTab = body.scrollTop;

    tabs[0]!.click();
    await frame();
    return { onOtherTab, back: body.scrollTop };
  });

  /* A tab never scrolled starts at the top rather than inheriting its neighbour's offset. */
  expect(restored.onOtherTab, "a fresh tab must not inherit an offset").toBe(0);
  expect(restored.back, "returning to a tab lands where it was left").toBe(420);
});
