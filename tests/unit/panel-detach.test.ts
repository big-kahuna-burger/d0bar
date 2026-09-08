// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detachedRoot,
  detachSupported,
  ensureStyleSheet,
  requestPanelWindow,
  type PictureInPictureWindow,
} from "../../src/panel/detach";

function hostWith(api?: object): Window {
  return { documentPictureInPicture: api } as unknown as Window;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("panel detachment", () => {
  it("is hidden when Document Picture-in-Picture is unavailable", () => {
    expect(detachSupported(hostWith())).toBe(false);
    expect(detachSupported(hostWith({ requestWindow() {} }))).toBe(true);
  });

  it("sizes the requested window from the rendered panel", async () => {
    const target = { closed: false } as PictureInPictureWindow;
    const requestWindow = vi.fn().mockResolvedValue(target);
    const panel = document.createElement("div");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 618.4,
      height: 511.2,
    } as DOMRect);

    await expect(requestPanelWindow(panel, hostWith({ requestWindow }))).resolves.toBe(target);
    expect(requestWindow).toHaveBeenCalledWith({ width: 619, height: 512 });
  });

  it("refuses a second live detached window", async () => {
    const open = { closed: false } as PictureInPictureWindow;
    await expect(
      requestPanelWindow(
        document.createElement("div"),
        hostWith({ window: open, requestWindow() {} }),
      ),
    ).rejects.toThrow("already open");
  });

  it("creates an isolated root in an otherwise empty PiP document", () => {
    const root = detachedRoot(window as PictureInPictureWindow);
    expect(document.body.children).toHaveLength(1);
    expect(root.host.hasAttribute("data-detached")).toBe(true);
  });

  it("restores the host panel stylesheet exactly once", () => {
    const pillSheet = {} as CSSStyleSheet;
    const panelSheet = {} as CSSStyleSheet;
    const root = { adoptedStyleSheets: [pillSheet] } as ShadowRoot;

    ensureStyleSheet(root, panelSheet);
    ensureStyleSheet(root, panelSheet);

    expect(root.adoptedStyleSheets).toEqual([pillSheet, panelSheet]);
  });
});
