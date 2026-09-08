import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Metric {
  name: string;
  value: number;
}

const budget = JSON.parse(
  readFileSync(join(process.cwd(), "bench", "budget.json"), "utf8"),
) as { panelDetach: Array<{ metric: string; threshold: number }> };
const HOST_SCRIPT_BUDGET = budget.panelDetach.find(
  (row) => row.metric === "detachedHostScriptMs",
)!.threshold;

async function exposeShadowRoots(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return original.call(this, { ...init, mode: "open" });
    };
  });
}

async function openAndDetach(page: Page, context: BrowserContext): Promise<Page> {
  await page.goto("/try/", { waitUntil: "load" });
  await page.waitForSelector("d0-bar");
  expect(
    await page.evaluate(() => "documentPictureInPicture" in window),
    "the panel-detach project requires Chromium with Document Picture-in-Picture enabled",
  ).toBe(true);

  await page.locator("d0-bar").click();
  const detach = page.locator("d0-bar").locator(".detach");
  await expect(detach).toBeVisible();

  const pipOpened = context.waitForEvent("page");
  await detach.click();
  const pip = await pipOpened;
  await pip.waitForLoadState("domcontentloaded");
  await expect(pip.locator(".panel")).toBeVisible();
  return pip;
}

test(
  "detached panel leaves only the pill and costs the host no rendering work",
  { tag: "@timing" },
  async ({ page, context }) => {
    await exposeShadowRoots(context);
    const pip = await openAndDetach(page, context);

    const hostDom = await page.evaluate(() => {
      const host = document.querySelector("d0-bar");
      return {
        hosts: document.querySelectorAll("d0-bar").length,
        bodyPanels: document.querySelectorAll(".panel").length,
        pill: host?.shadowRoot?.querySelectorAll(".pill").length ?? 0,
        panel: host?.shadowRoot?.querySelectorAll(".panel").length ?? 0,
      };
    });
    expect(hostDom).toEqual({ hosts: 1, bodyPanels: 0, pill: 1, panel: 0 });

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("LayerTree.enable");
    let paints = 0;
    cdp.on("LayerTree.layerPainted", () => paints++);

    const metrics = async (): Promise<Map<string, number>> => {
      const result = (await cdp.send("Performance.getMetrics")) as { metrics: Metric[] };
      return new Map(result.metrics.map((metric) => [metric.name, metric.value]));
    };
    const before = await metrics();

    /* Drive state and layout in the PiP target. None of these interactions should reach the host
       document's style, layout or paint pipelines. */
    for (let pass = 0; pass < 20; pass += 1) {
      await pip.getByRole("tab", { name: pass % 2 === 0 ? "Vitals" : "Requests" }).click();
    }
    await pip.waitForTimeout(100);

    const after = await metrics();
    await cdp.detach();
    const delta = (name: string): number => (after.get(name) ?? 0) - (before.get(name) ?? 0);
    const scriptMs = delta("ScriptDuration") * 1000;

    test.info().annotations.push({
      type: "frame-budget",
      description: JSON.stringify({ rowId: "detachedHostScriptMs", observed: scriptMs }),
    });

    expect(delta("RecalcStyleCount"), "host style recalculations while detached").toBe(0);
    expect(delta("LayoutCount"), "host layouts while detached").toBe(0);
    expect(paints, "host layer paints while detached").toBe(0);
    expect(scriptMs, "host script time while detached").toBeLessThanOrEqual(HOST_SCRIPT_BUDGET);
  },
);
