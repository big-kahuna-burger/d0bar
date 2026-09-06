// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { regionsIn, originFor } from "../../src/shared/regions";
import { connectView, type ConnectView } from "../../src/panel/views/connect";
import { connection, view } from "../../src/panel/shell";

/**
 * The connect surface's region picker.
 *
 * Tested here rather than in a browser spec for one practical reason: the picker is a native
 * `<select>` inside a **closed** shadow root, and its dropdown is painted by the OS outside the
 * page — a browser driver can neither reach the element nor see the popup. `connectView()`
 * returns its own root element, so jsdom exercises exactly the code the panel mounts.
 *
 * What matters and is asserted below: the options are the compiled table and nothing else, and
 * the origin shown under the picker is derived from the selection rather than typed twice.
 */

function selectOf(surface: ConnectView): HTMLSelectElement {
  const node = surface.el.querySelector<HTMLSelectElement>(".conn-select");
  if (!node) throw new Error("the connect surface has no region picker");
  return node;
}

function envButton(surface: ConnectView, label: string): HTMLButtonElement {
  const found = [...surface.el.querySelectorAll<HTMLButtonElement>(".conn-toggle-btn")].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no environment button labelled ${label}`);
  return found;
}

function originOf(surface: ConnectView): string {
  return surface.el.querySelector(".conn-origin")?.textContent ?? "";
}

describe("the environment toggle and region picker", () => {
  let surface: ConnectView;

  beforeEach(() => {
    view.set("list");
    connection.set({ connected: false, source: "none", hint: "", apiOrigin: "" });
  });

  afterEach(() => {
    surface.destroy();
    delete (globalThis as { D0BAR_REGION?: unknown }).D0BAR_REGION;
  });

  it("offers the compiled table for the selected environment and nothing else", () => {
    surface = connectView();
    const options = [...selectOf(surface).options].map((option) => option.value);
    /* The list is the security property. A picker that could name an origin the worker did not
       compile in would be the page choosing where the token goes. */
    expect(options).toEqual(regionsIn("prod").map((region) => region.id));
  });

  it("swaps the region list when the environment toggle changes", () => {
    surface = connectView();
    expect(selectOf(surface).value).toBe("prod:eu-west-1");

    envButton(surface, "Development").click();
    expect([...selectOf(surface).options].map((option) => option.value)).toEqual(
      regionsIn("dev").map((region) => region.id),
    );
    expect(originOf(surface)).toBe("https://api.eu-west-1.aws.dash0-dev.com");

    envButton(surface, "Production").click();
    /* Not the dev region carried across: it does not exist in prod, and a control left showing
       an id the worker cannot resolve would connect to nothing while looking selected. */
    expect(selectOf(surface).value).toBe("prod:eu-west-1");
    expect(originOf(surface)).toBe("https://api.eu-west-1.aws.dash0.com");
  });

  it("shows the origin for the current selection, not a second copy of it", () => {
    surface = connectView();
    const select = selectOf(surface);
    expect(originOf(surface)).toBe(originFor(select.value));

    select.value = "prod:us-west-2";
    select.dispatchEvent(new Event("change"));
    expect(originOf(surface)).toBe("https://api.us-west-2.aws.dash0.com");
  });

  it("preselects the debug global when it names a known region", () => {
    (globalThis as { D0BAR_REGION?: unknown }).D0BAR_REGION = "prod:us-west-2";
    surface = connectView();
    expect(selectOf(surface).value).toBe("prod:us-west-2");
    expect(originOf(surface)).toBe("https://api.us-west-2.aws.dash0.com");
  });

  it("starts in the environment the debug global names", () => {
    (globalThis as { D0BAR_REGION?: unknown }).D0BAR_REGION = "dev:eu-west-1";
    surface = connectView();
    expect(envButton(surface, "Development").getAttribute("aria-checked")).toBe("true");
    expect(originOf(surface)).toBe("https://api.eu-west-1.aws.dash0-dev.com");
  });

  it("ignores a debug global naming anything the table does not carry", () => {
    /* The global is read off the page, so it is the page speaking. It gets to preselect a row
       that already exists and nothing more — an unknown value falls back to the default rather
       than adding a destination. */
    (globalThis as { D0BAR_REGION?: unknown }).D0BAR_REGION = "https://evil.test";
    surface = connectView();
    expect(selectOf(surface).value).toBe("prod:eu-west-1");
    expect(envButton(surface, "Production").getAttribute("aria-checked")).toBe("true");
  });
});
