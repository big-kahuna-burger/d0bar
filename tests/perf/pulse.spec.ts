import { expect, test } from "@playwright/test";

/**
 * The pill's activity dot.
 *
 * Purple at rest, one blink to yellow when a batch of requests lands, settling back through
 * the midpoint of the two. Asserted in a browser because every part of it is a browser fact:
 * whether the keyframes apply at all, what `color-mix(in oklab, …)` resolves to, and whether
 * restarting via `Animation.currentTime` actually replays the blink.
 *
 * The animation is *driven* rather than sampled — paused, then stepped to fixed offsets — so
 * the assertions do not race the 620ms it runs for. A wall-clock sample would be flaky and
 * would prove less: it could not distinguish "settled back to purple" from "never fired".
 *
 * Shadow-root seam as in `panel-shell.spec.ts`: `attachShadow` is patched from the outside,
 * which leaves the production path untouched. Note that `document.getAnimations()` cannot be
 * used here even with the root open — Blink filters it by tree scope, so an animation inside
 * any shadow root is invisible to it. That is a real trap: the first probe of this feature
 * returned an empty list and looked like the dot was dead.
 */

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
    __d0root: ShadowRoot | undefined;
  }
}

/** `--cta-bg` #7c3aed and `--warning-bg` #ffe54f, as sRGB bytes. */
const PURPLE = [124, 58, 237];
const YELLOW = [255, 229, 79];

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
  await page.waitForFunction(() => window.__d0root?.querySelector(".pulse") !== null);
});

test("the dot rests purple and blinks yellow when requests fire", async ({ page }) => {
  /* The resting colour is not read here first. The fixture keeps issuing requests, so on a
     live page the dot is as likely as not to be mid-blink — the first run of this test read
     yellow and failed, which was the animation working rather than a defect. It is asserted
     below instead, off a cancelled animation, where "at rest" is a fact rather than a bet.

     A burst the pill's 500ms clock is certain to see. The body is consumed on purpose: a
     fetch whose body is never read produces no `PerformanceResourceTiming` entry in Chromium
     at all, so an unconsumed burst would move no counter and fire no blink. */
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i += 1) {
      await fetch(`/api/quote?pulse=${i}`).then((r) => r.text());
    }
  });

  const frames = await page.waitForFunction(
    () => {
      const dot = window.__d0root!.querySelector(".pulse") as HTMLElement;
      const [animation] = dot.getAnimations();
      if (!animation) return null;

      /* Painted into a canvas and read back as bytes rather than string-matched. The mid stop
         is `color-mix(in oklab, …)` and Chrome serialises that computed value in its own
         space — the first run of this test parsed `0.729471` out of it and compared it to
         `124`. One pixel is the browser's own answer to "what colour is this", in the only
         space the assertion cares about. */
      const context = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      const bytes = (color: string): number[] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };

      /* Driven, not sampled — see the file note. */
      animation.pause();
      const at = (ms: number): number[] => {
        animation.currentTime = ms;
        return bytes(getComputedStyle(dot).backgroundColor);
      };
      const duration = 620;
      const result = {
        start: at(0),
        blink: at(duration * 0.2),
        settle: at(duration * 0.66),
        end: at(duration),
      };
      animation.cancel();
      /* Read after cancelling: with no animation applying, this is the dot's own colour. */
      return { ...result, rest: bytes(getComputedStyle(dot).backgroundColor) };
    },
    undefined,
    { timeout: 5000 },
  );
  /* `waitForFunction` types its handle as possibly null because the predicate returns null
     until the animation exists; by here it has resolved with a value. */
  const shape = (await frames.jsonValue())!;

  expect(shape.rest, "the dot is purple with nothing animating it").toEqual(PURPLE);
  expect(shape.start, "the blink starts from rest").toEqual(PURPLE);
  expect(shape.blink, "and goes to yellow").toEqual(YELLOW);
  expect(shape.end, "and comes back").toEqual(PURPLE);

  /* The mid stop is asserted as *between* rather than pinned to a triple: it is produced by
     an oklab mix, and pinning it would make this test a record of one Chrome version's
     conversion rather than of the thing that matters — that the settle passes through a third
     colour instead of cutting straight back. */
  const [mr, mg, mb] = shape.settle as number[];
  expect(shape.settle, "the settle is neither endpoint").not.toEqual(PURPLE);
  expect(shape.settle).not.toEqual(YELLOW);
  expect(mr!, "red between purple and yellow").toBeGreaterThan(PURPLE[0]!);
  expect(mr!).toBeLessThan(YELLOW[0]!);
  expect(mg!, "green between purple and yellow").toBeGreaterThan(PURPLE[1]!);
  expect(mg!).toBeLessThan(YELLOW[1]!);
  expect(mb!, "blue between yellow and purple").toBeGreaterThan(YELLOW[2]!);
  expect(mb!).toBeLessThan(PURPLE[2]!);
});

test("the dot is still and purple under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await page.evaluate(async () => {
    const dot = window.__d0root!.querySelector(".pulse") as HTMLElement;
    /* Force the class on directly: what is under test is that the CSS refuses to animate it,
       not that a request happens to land during this test. */
    dot.classList.add("firing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      running: dot.getAnimations().length,
      color: getComputedStyle(dot).backgroundColor,
    };
  });

  expect(state.running, "no animation at all, so the JS restart is a no-op loop").toBe(0);
  expect(state.color, "and the dot stays purple").toBe("rgb(124, 58, 237)");
});
