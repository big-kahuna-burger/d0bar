// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  beginPhaseTracking,
  currentPhase,
  noteLoaded,
  resetPhase,
  settleNow,
  whenNetworkPermitted,
  whenSettled,
} from "../../src/collector/phase";

/**
 * The moratorium ends at settle. The toolbar's own network requests do not.
 *
 * LCP is final at first input, per the standard, so a user who clicks while the page is still
 * loading settles the phase mid-load. Everything settle gates is then permitted — including,
 * before this change, a stage-2 prefetch whose whole justification is that it must not compete
 * with the host page's own critical requests.
 */

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const stop of teardowns) stop();
  teardowns.length = 0;
  resetPhase();
});

/**
 * These tests drive the two signals directly rather than through
 * {@link beginPhaseTracking}, because jsdom reports `document.readyState === "complete"` and
 * has no `navigation` entry type, so starting tracking there calls `noteLoaded` immediately —
 * which is correct behaviour and the wrong starting state for the ordering under test.
 */
function track(): void {
  teardowns.push(beginPhaseTracking());
}

describe("whenNetworkPermitted", () => {
  it("does not fire on settle alone, when settle arrived before load", () => {
    let fired = 0;
    whenNetworkPermitted(() => fired++);

    /* A click during load: LCP is final, the moratorium lifts. */
    settleNow();
    expect(currentPhase()).toBe("settled");
    expect(fired).toBe(0);

    noteLoaded();
    expect(fired).toBe(1);
  });

  it("does not fire on load alone", () => {
    let fired = 0;
    whenNetworkPermitted(() => fired++);

    noteLoaded();
    expect(fired).toBe(0);

    settleNow();
    expect(fired).toBe(1);
  });

  it("fires immediately when both have already happened", () => {
    settleNow();
    noteLoaded();

    let fired = 0;
    whenNetworkPermitted(() => fired++);
    expect(fired).toBe(1);
  });

  it("fires each subscriber exactly once", () => {
    let fired = 0;
    whenNetworkPermitted(() => fired++);
    settleNow();
    noteLoaded();
    /* A second `noteLoaded` is the ordinary case — the navigation entry is delivered twice. */
    noteLoaded();
    settleNow();
    expect(fired).toBe(1);
  });

  it("is still gated by settle, not merely by load, for the moratorium's own sake", () => {
    track();
    let settled = 0;
    let permitted = 0;
    whenSettled(() => settled++);
    whenNetworkPermitted(() => permitted++);

    noteLoaded();
    expect(settled).toBe(0);
    expect(permitted).toBe(0);
  });

  it("starts tracking already loaded where the environment says the page is complete", () => {
    /* Not an accident of the test environment but the documented fallback: without the
       `navigation` entry type, `beginPhaseTracking` reads `document.readyState` once. */
    track();
    let fired = 0;
    whenNetworkPermitted(() => fired++);
    settleNow();
    expect(fired).toBe(1);
  });
});
