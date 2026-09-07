import { beforeEach, describe, expect, it } from "vitest";
import {
  escape,
  inpDelta,
  perturbation,
  inpDeltaMode,
  openLog,
  popToList,
  recallScroll,
  rememberScroll,
  resetShell,
  selectTab,
  selected,
  selectedLog,
  selectedSpan,
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
    expect(text).toBe("Δ INP unmeasured");
  });

  it("says unmeasured when the browser cannot attribute, even holding a number", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    /* No `long-animation-frame`, so nothing looked. A stale figure from before the mode was
       resolved must not be rendered as though something had. */
    inpDelta.set(0.4);
    inpDeltaMode.set("unavailable");
    expect(perturbation()).toEqual({ text: "Δ INP unmeasured", state: "unknown" });
  });

  it("quotes the measured value once there is one, in the warning state", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDeltaMode.set("url");
    inpDelta.set(0.42);
    /* `warn`, not `ok`: a measured non-zero cost is the finding this panel exists to disclose,
       and giving it zero's colour would bury it. */
    expect(perturbation()).toEqual({ text: "Δ INP 0.4ms", state: "warn" });
  });

  it("renders a measured zero as ok, because nothing found is a real answer", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDeltaMode.set("url");
    inpDelta.set(0);
    expect(perturbation()).toEqual({ text: "Δ INP 0.0ms", state: "ok" });
  });

  it("never floors a real cost to zero", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDeltaMode.set("url");
    /* `toFixed(1)` would print `0.0` here, which is the exact claim the spec forbids. */
    inpDelta.set(0.04);
    const { text, state } = perturbation();
    expect(text).toBe("Δ INP <0.1ms");
    expect(state).toBe("warn");
  });

  it("marks a bundled build's figure as a floor", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    /* d0bar inlined into the host's own chunk: `sourceURL` cannot separate the two, so what is
       reported is only what a reserved name proved. */
    inpDeltaMode.set("lower-bound");
    inpDelta.set(1.25);
    expect(perturbation()).toEqual({ text: "Δ INP 1.3ms (min)", state: "warn" });
  });

  it("follows tier 2 being lost after mount", () => {
    tier2.set({ kind: "live", owner: "d0bar" });
    inpDeltaMode.set("url");
    inpDelta.set(1.25);
    expect(perturbation().state).toBe("warn");
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

/**
 * The log detail view sits on the trace, which makes the surface stack three deep and Escape's
 * meaning depth-dependent. Each step is asserted here rather than in the view, because it is a
 * decision about where a reader lands and not a thing to see.
 */
describe("the log surface", () => {
  it("pops to the trace, not to the list", () => {
    /* The load-bearing half: `selected` stays set. The trace view's only entry into the query
       machine is an effect over `open`/`view`/`selected`, so clearing it would abort the query
       whose summary holds the record the reader just closed. */
    selected.set(3);
    view.set("trace");
    openLog(1);
    expect([view(), selectedLog()]).toEqual(["log", 1]);

    escape();
    expect([view(), selected(), selectedLog()]).toEqual(["trace", 3, -1]);
  });

  it("takes two Escapes to reach the list from a log record", () => {
    selected.set(3);
    view.set("trace");
    openLog(0);
    escape();
    escape();
    expect([view(), selected()]).toEqual(["list", -1]);
  });

  it("drops both trace-scoped selections when the trace itself is popped", () => {
    /* `selectedLog` is an index into a summary that `popToList` discards, and `selectedSpan` a row
       index into a buffer it discards with it. Either one surviving would point into the *next*
       trace the reader opens. */
    selected.set(3);
    view.set("trace");
    selectedSpan.set(7);
    openLog(2);
    popToList();
    expect([selectedLog(), selectedSpan()]).toEqual([-1, -1]);
  });

  it("forgets both on reset", () => {
    openLog(2);
    selectedSpan.set(7);
    resetShell();
    expect([view(), selectedLog(), selectedSpan()]).toEqual(["list", -1, -1]);
  });
});
