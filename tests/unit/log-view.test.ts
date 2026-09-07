// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { logView, valueText, UNATTACHED_COPY } from "../../src/panel/views/log";
import { escape, openLog, resetShell, selectedLog, view } from "../../src/panel/shell";
import { ATTR_CAP, type LogRecord } from "../../src/shared/protocol";

/**
 * The log detail view.
 *
 * Two properties carry the change, and both are about *not* misreporting a record:
 *
 * - a value with no readable text is **named**, never blank. A `kvlistValue` body rendered as a
 *   level, a time and nothing reads as an empty log line, which is a different fact.
 * - a truncated attribute list names both numbers. `64 attributes` on a record holding 300 is a
 *   count of what this panel chose to show, presented as a count of what the record has.
 *
 * The record arrives as an **index** resolved against a live array, so the last case here is the
 * one a stale index produces: the view says the record is gone rather than rendering the wrong one.
 */

function logRecord(over: Partial<LogRecord> = {}): LogRecord {
  return {
    severity: 17,
    level: "ERROR",
    body: "tariff lookup failed",
    bodyKind: "string",
    offsetNs: 24_000_000,
    timeNs: 1_700_000_000_000_000_000,
    row: -1,
    unattached: "no-span-id",
    attrs: [],
    attrsSeen: 0,
    ...over,
  };
}

interface Mounted {
  el: HTMLElement;
  destroy(): void;
}

function mount(logs: LogRecord[]): Mounted {
  const created = logView({ logs: () => logs });
  document.body.appendChild(created.el);
  return created;
}

function textOf(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}

function visible(root: HTMLElement, selector: string): boolean {
  const node = root.querySelector<HTMLElement>(selector);
  return node !== null && !node.hidden;
}

beforeEach(() => {
  resetShell();
  document.body.replaceChildren();
});

describe("valueText", () => {
  it("returns text where a value has text, and its kind where it does not", () => {
    expect(valueText("GET", "string")).toBe("GET");
    /* A genuinely empty string stays empty rather than becoming `⟨no value⟩` — the emitter did
       set it, and saying it set nothing would be false. */
    expect(valueText("", "string")).toBe("");
    expect(valueText("503", "int")).toBe("503");
    expect(valueText("", "kvlist")).toBe("⟨kvlist⟩");
    expect(valueText("", "array")).toBe("⟨array⟩");
    expect(valueText("", "bytes")).toBe("⟨bytes⟩");
    expect(valueText("", "absent")).toBe("⟨no value⟩");
  });
});

describe("the record", () => {
  it("renders the level, the offset and the wall clock", () => {
    const surface = mount([logRecord()]);
    openLog(0);
    expect(textOf(surface.el, ".logview-level")).toBe("ERROR");
    /* Both, because they answer different questions: the offset places the record inside the
       trace, and the ISO time is what a reader pastes into a log search. */
    expect(textOf(surface.el, ".logview-when")).toBe("+24.0ms · 2023-11-14T22:13:20.000Z");
    surface.destroy();
  });

  it("distinguishes an empty body from no body at all", () => {
    const empty = mount([logRecord({ body: "", bodyKind: "string" })]);
    openLog(0);
    expect(textOf(empty.el, ".logview-body")).toBe("⟨empty⟩");
    empty.destroy();

    const none = mount([logRecord({ body: "", bodyKind: "absent" })]);
    openLog(0);
    expect(textOf(none.el, ".logview-body")).toBe("⟨no body⟩");
    none.destroy();
  });

  it("names a container body instead of showing a blank line", () => {
    const surface = mount([logRecord({ body: "", bodyKind: "kvlist" })]);
    openLog(0);
    expect(textOf(surface.el, ".logview-body")).toBe("⟨kvlist⟩");
    surface.destroy();
  });

  it("states an absent timestamp rather than rendering 1970", () => {
    const surface = mount([logRecord({ timeNs: 0, offsetNs: 0 })]);
    openLog(0);
    expect(textOf(surface.el, ".logview-when")).toBe("+0µs · no timestamp");
    surface.destroy();
  });
});

describe("attributes", () => {
  it("says there are none rather than showing an empty list", () => {
    const surface = mount([logRecord()]);
    openLog(0);
    expect(textOf(surface.el, ".logview-attrs-head")).toBe("no attributes");
    expect(surface.el.querySelectorAll(".logview-attrs dt")).toHaveLength(0);
    surface.destroy();
  });

  it("renders each key with its value, and names a non-string kind", () => {
    const surface = mount([
      logRecord({
        attrs: [
          { key: "http.method", value: "GET", kind: "string" },
          { key: "corridor", value: "", kind: "kvlist" },
          { key: "keyless", value: "", kind: "absent" },
        ],
        attrsSeen: 3,
      }),
    ]);
    openLog(0);
    const keys = [...surface.el.querySelectorAll<HTMLElement>(".logview-attrs dt")];
    const values = [...surface.el.querySelectorAll<HTMLElement>(".logview-attrs dd")];
    expect(keys.map((node) => node.textContent)).toEqual([
      "http.method",
      "corridor",
      "keyless",
    ]);
    expect(values.map((node) => node.textContent)).toEqual(["GET", "⟨kvlist⟩", "⟨no value⟩"]);
    /* The kind is on the element so the stylesheet can mute a named kind — this panel's word for
       the value, kept distinct from the value itself. */
    expect(values.map((node) => node.dataset["kind"])).toEqual(["string", "kvlist", "absent"]);
    expect(textOf(surface.el, ".logview-attrs-head")).toBe("attributes · 3");
    surface.destroy();
  });

  it("names both numbers when the list was truncated", () => {
    const surface = mount([
      logRecord({
        attrs: [{ key: "a", value: "1", kind: "string" }],
        attrsSeen: 300,
      }),
    ]);
    openLog(0);
    expect(textOf(surface.el, ".logview-attrs-head")).toBe(
      `attributes · showing 1 of 300 (capped at ${ATTR_CAP})`,
    );
    surface.destroy();
  });

  it("repaints when a different record is opened", () => {
    /* The list is a subtree written by an `effect`, not a bound text node. A repaint that failed
       to subscribe would leave the first record's attributes under the second record's header. */
    const surface = mount([
      logRecord({ attrs: [{ key: "first", value: "1", kind: "string" }], attrsSeen: 1 }),
      logRecord({ attrs: [{ key: "second", value: "2", kind: "string" }], attrsSeen: 1 }),
    ]);
    openLog(0);
    expect(textOf(surface.el, ".logview-attrs dt")).toBe("first");
    openLog(1);
    expect(textOf(surface.el, ".logview-attrs dt")).toBe("second");
    surface.destroy();
  });
});

describe("records with no span", () => {
  it("explains why, in full, per reason", () => {
    for (const reason of ["no-span-id", "span-not-in-trace", "span-capped"] as const) {
      const surface = mount([logRecord({ unattached: reason })]);
      openLog(0);
      expect(visible(surface.el, ".logview-unattached")).toBe(true);
      expect(textOf(surface.el, ".logview-unattached")).toBe(UNATTACHED_COPY[reason]);
      surface.destroy();
    }
  });

  it("says nothing about attachment when the record has a row", () => {
    const surface = mount([logRecord({ row: 4, unattached: 0 })]);
    openLog(0);
    expect(visible(surface.el, ".logview-unattached")).toBe(false);
    surface.destroy();
  });

  it("keeps span-capped as its own sentence, distinct from not-in-trace", () => {
    /* The claim the enum exists to prevent: "not in this trace" about a span the trace contains. */
    expect(UNATTACHED_COPY["span-capped"]).not.toBe(UNATTACHED_COPY["span-not-in-trace"]);
    expect(UNATTACHED_COPY["span-capped"]).toMatch(/was not rendered/);
  });
});

describe("navigation", () => {
  it("returns to the trace, not to the list", () => {
    /* `popToList` would clear `selected`, which aborts the query whose summary holds this record —
       the reader would come back to a trace that had to be fetched again. */
    const surface = mount([logRecord()]);
    openLog(0);
    expect(view()).toBe("log");
    surface.el.querySelector<HTMLButtonElement>(".logview-back")!.click();
    expect(view()).toBe("trace");
    expect(selectedLog()).toBe(-1);
    surface.destroy();
  });

  it("pops one level on Escape", () => {
    const surface = mount([logRecord()]);
    openLog(0);
    escape();
    expect(view()).toBe("trace");
    surface.destroy();
  });
});

describe("a stale index", () => {
  it("says the record is gone rather than rendering a different one", () => {
    /* The index is resolved against the live array on every read. A re-layout that returns fewer
       records must not leave this view showing whatever now sits at that index — and holding the
       object instead would leave it showing a record the trace no longer contains. */
    const logs = [logRecord(), logRecord({ body: "second" })];
    const surface = mount(logs);
    openLog(1);
    expect(visible(surface.el, ".logview-gone")).toBe(false);

    logs.length = 1;
    /* `logs` is a plain accessor, not a signal, so shortening the array signals nothing on its
       own — in production the change arrives as a new summary object. Forced here by moving the
       selection off the index and back, which is what makes the view re-resolve it. */
    openLog(0);
    openLog(1);
    expect(visible(surface.el, ".logview-gone")).toBe(true);
    expect(visible(surface.el, ".logview-body")).toBe(false);
    surface.destroy();
  });
});

describe("destroy", () => {
  it("removes the element and stops responding to the shell", () => {
    const surface = mount([logRecord()]);
    openLog(0);
    const el = surface.el;
    surface.destroy();
    expect(el.isConnected).toBe(false);
    /* The bindings are disposed, so a later shell change writes nothing. A leaked effect here
       would keep the detached subtree alive for the life of the page. */
    openLog(0);
    expect(textOf(el, ".logview-level")).toBe("ERROR");
    resetShell();
    expect(textOf(el, ".logview-level")).toBe("ERROR");
  });
});
