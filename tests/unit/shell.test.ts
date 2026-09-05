import { beforeEach, describe, expect, it } from "vitest";
import {
  escape,
  inpDelta,
  perturbation,
  recallScroll,
  rememberScroll,
  resetShell,
  selectTab,
  tab,
  tier2,
  view,
} from "../../src/panel/shell";

/**
 * Shell state, tested without a DOM.
 *
 * The two properties here — which perturbation reading is honest, and where returning from a
 * trace lands — are decisions, not rendering. They live in `shell.ts` precisely so they can be
 * settled by a node test rather than by reading pixels, and so the panel's paint code cannot
 * quietly disagree with them.
 */

beforeEach(() => {
  resetShell();
});

describe("perturbation label", () => {
  it("reports the missing capability, not a number, when tier 2 is off", () => {
    tier2.set({ kind: "off", reason: "scope-owned" });
    /* Even with a measurement in hand: the degraded reading outranks it, because a trace jump
       the user cannot make is the more actionable fact. */
    inpDelta.set(0.4);
    expect(perturbation()).toEqual({ text: "degraded — no trace jump", state: "degraded" });
  });

  it("never renders an unmeasured cost as zero", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDelta.set(null);
    const { text, state } = perturbation();
    expect(state).toBe("unknown");
    /* The specific regression this guards: `Δ INP 0.0ms` is a claim that the toolbar cost
       nothing, and printing it before anything has measured it would make the panel lie about
       the one property it exists to defend. */
    expect(text).not.toContain("0.0");
    expect(text).toBe("Δ INP unavailable");
  });

  it("quotes the measured value once there is one", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDelta.set(0.42);
    expect(perturbation()).toEqual({ text: "Δ INP 0.4ms", state: "ok" });
  });

  it("follows tier 2 being lost after mount", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDelta.set(1.25);
    expect(perturbation().state).toBe("ok");
    /* The host registered its own worker at `/` and took the scope. */
    tier2.set({ kind: "off", reason: "scope-owned" });
    expect(perturbation().state).toBe("degraded");
  });
});

describe("returning from a trace", () => {
  it("preserves the active tab", () => {
    selectTab("vitals");
    view.set("trace");
    escape();
    expect(view()).toBe("list");
    expect(tab()).toBe("vitals");
  });

  it("preserves scroll position across the trace round trip", () => {
    selectTab("requests");
    rememberScroll("requests", 480);
    view.set("trace");
    escape();
    expect(recallScroll(tab())).toBe(480);
  });

  it("keeps a separate offset per tab", () => {
    rememberScroll("requests", 480);
    rememberScroll("untraced", 120);
    expect(recallScroll("requests")).toBe(480);
    expect(recallScroll("untraced")).toBe(120);
    /* A tab never scrolled reads zero rather than inheriting its neighbour's offset — the
       panel assigns this value unconditionally, so a missing entry must not mean "leave it". */
    expect(recallScroll("vitals")).toBe(0);
  });

  it("forgets offsets on reset", () => {
    rememberScroll("requests", 480);
    resetShell();
    expect(recallScroll("requests")).toBe(0);
  });
});
