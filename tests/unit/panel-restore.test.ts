// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPanelRestore,
  readPanelRestore,
  savePanelRestore,
  type PanelRestoreState,
} from "../../src/shared/panel-restore";

const state: PanelRestoreState = {
  path: "/try/",
  tab: "vitals",
  view: "list",
  selected: 7,
  selectedLog: -1,
  selectedSpan: -1,
  scroll: { vitals: 128 },
  width: 620,
  height: 560,
};

afterEach(() => clearPanelRestore());

describe("detached panel restoration", () => {
  it("round-trips serializable UI state for the same route", () => {
    savePanelRestore(state);
    expect(readPanelRestore("/try/")).toEqual(state);
  });

  it("does not restore state onto another route", () => {
    savePanelRestore(state);
    expect(readPanelRestore("/other")).toBeUndefined();
  });

  it("rejects malformed stored state", () => {
    sessionStorage.setItem("d0bar:panel-restore:v1", "{not json");
    expect(readPanelRestore("/try/")).toBeUndefined();
  });
});
