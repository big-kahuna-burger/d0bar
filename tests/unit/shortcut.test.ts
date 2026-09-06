// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShortcut, parseChord } from "../../src/collector/shortcut";

/**
 * The shortcut is the toolbar's only listener on the host page, so its behaviour is the
 * behaviour of that whole concession. Everything here is about what it declines to do.
 */

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const stop of teardowns) stop();
  teardowns.length = 0;
});

function install(options: Parameters<typeof installShortcut>[0]): void {
  teardowns.push(installShortcut(options));
}

function press(init: Partial<KeyboardEventInit> & { code: string }, target?: Element): void {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (target ?? document.body).dispatchEvent(event);
}

describe("parseChord", () => {
  it("maps digits and letters to physical key codes", () => {
    /* `code`, not `key`: on a layout where shift-0 produces `)`, a chord written against
       `key` would never fire. */
    expect(parseChord("Mod+Shift+0")).toEqual({
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
      code: "Digit0",
    });
    expect(parseChord("Ctrl+Alt+d")?.code).toBe("KeyD");
  });

  it("accepts an explicit code for keys that are neither", () => {
    expect(parseChord("Mod+Backquote")?.code).toBe("Backquote");
  });

  it("rejects a spec with no key in it", () => {
    expect(parseChord("Mod+Shift")).toBeUndefined();
  });
});

describe("installShortcut", () => {
  it("registers nothing when disabled", () => {
    const add = vi.spyOn(document, "addEventListener");
    install({ shortcut: false, onToggle: () => {} });
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it("registers nothing when the chord cannot be parsed", () => {
    const add = vi.spyOn(document, "addEventListener");
    install({ shortcut: "Mod+Shift", onToggle: () => {} });
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it("fires on the chord and claims the keystroke", () => {
    const onToggle = vi.fn();
    install({ shortcut: "Ctrl+Shift+0", onToggle });

    const event = new KeyboardEvent("keydown", {
      code: "Digit0",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented, "the host page must not also act on it").toBe(true);
  });

  it("ignores a near miss rather than guessing", () => {
    const onToggle = vi.fn();
    install({ shortcut: "Ctrl+Shift+0", onToggle });

    press({ code: "Digit0", ctrlKey: true });
    press({ code: "Digit0", shiftKey: true });
    press({ code: "Digit1", ctrlKey: true, shiftKey: true });
    press({ code: "Digit0", ctrlKey: true, shiftKey: true, altKey: true });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does not repeat while the key is held", () => {
    const onToggle = vi.fn();
    install({ shortcut: "Ctrl+Shift+0", onToggle });

    press({ code: "Digit0", ctrlKey: true, shiftKey: true });
    press({ code: "Digit0", ctrlKey: true, shiftKey: true, repeat: true });
    press({ code: "Digit0", ctrlKey: true, shiftKey: true, repeat: true });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way while the user is typing", () => {
    const onToggle = vi.fn();
    install({ shortcut: "Ctrl+Shift+0", onToggle });

    for (const tag of ["input", "textarea", "select"]) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      press({ code: "Digit0", ctrlKey: true, shiftKey: true }, field);
      field.remove();
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    /* jsdom does not implement `isContentEditable`, so it is defined here rather than
       assumed — the production path reads the real property. */
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.appendChild(editable);
    press({ code: "Digit0", ctrlKey: true, shiftKey: true }, editable);
    editable.remove();

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("lets the host page stop the chord before it is seen", () => {
    const onToggle = vi.fn();
    install({ shortcut: "Ctrl+Shift+0", onToggle });

    /* Registered on an inner node, so it runs before the document-level handler. A page that
       already owns this chord keeps it. */
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.addEventListener("keydown", (event) => event.stopPropagation());

    press({ code: "Digit0", ctrlKey: true, shiftKey: true }, host);

    expect(onToggle).not.toHaveBeenCalled();
    host.remove();
  });

  it("removes its listener on teardown", () => {
    const onToggle = vi.fn();
    const stop = installShortcut({ shortcut: "Ctrl+Shift+0", onToggle });
    stop();

    press({ code: "Digit0", ctrlKey: true, shiftKey: true });

    expect(onToggle).not.toHaveBeenCalled();
  });
});
