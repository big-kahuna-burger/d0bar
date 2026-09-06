/**
 * Records a real vitals entry dump from the bench fixture.
 *
 * `tests/unit/vitals-reference.test.ts` replays this through the accumulator and compares the
 * result against a reference implementation written from the standard definitions. Both halves
 * matter: a reference implementation checked only against synthetic entries proves the two
 * agree about a shape the browser may never produce, and a recorded dump with nothing to check
 * it against proves nothing at all.
 *
 * Committed rather than regenerated per run, for the same reason `bench/fixtures/trace-*.json`
 * is: a test whose input changes between runs cannot fail reproducibly. Re-record with
 * `node scripts/record-vitals-fixture.mjs` when the fixture's own behaviour changes.
 *
 * The entries are captured as plain objects. Live DOM nodes on `sources[].node`, `element` and
 * `target` cannot cross into JSON, so what is recorded for those is the selector the toolbar
 * would derive — enough to assert attribution without the dump retaining a document.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8732;
const OUT = join(root, "tests", "fixtures", "vitals-entries.json");

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* Not up yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`fixture server did not come up at ${url}`);
}

const server = spawn("node", [join(root, "bench", "fixtures", "server.mjs")], {
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  await waitForServer(`http://127.0.0.1:${PORT}/health`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  /* `layout-shift`, `largest-contentful-paint` and `event` are observer-only: they never land
     in the performance timeline, so `getEntriesByType` returns nothing for them. The first
     attempt at this recorder used `getEntriesByType` and produced a dump with two long frames
     and nothing else. Observers, registered before the page runs. */
  await page.addInitScript(() => {
    const selectorOf = (node) => {
      if (!node || typeof node.tagName !== "string") return "";
      const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
      const qualifier = node.id ? `#${node.id}` : cls ? `.${cls}` : "";
      return (node.tagName.toLowerCase() + qualifier).slice(0, 64);
    };
    const dump = {
      "largest-contentful-paint": [],
      "layout-shift": [],
      event: [],
      "long-animation-frame": [],
    };
    window.__vitalsDump = dump;
    const shapes = {
      "largest-contentful-paint": (e) => ({ element: selectorOf(e.element) }),
      "layout-shift": (e) => ({
        value: e.value,
        hadRecentInput: e.hadRecentInput,
        sources: [...(e.sources ?? [])].map((s) => ({ node: selectorOf(s.node) })),
      }),
      event: (e) => ({
        interactionId: e.interactionId,
        processingStart: e.processingStart,
        target: selectorOf(e.target),
      }),
      "long-animation-frame": (e) => ({
        scripts: [...(e.scripts ?? [])].map((s) => ({
          duration: s.duration,
          sourceFunctionName: s.sourceFunctionName,
        })),
      }),
    };
    for (const [type, shape] of Object.entries(shapes)) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            dump[type].push({
              entryType: type,
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
              ...shape(entry),
            });
          }
        }).observe(
          type === "event"
            ? { type, buffered: true, durationThreshold: 40 }
            : { type, buffered: true },
        );
      } catch {
        /* Entry type unsupported here; the dump records its absence as an empty array. */
      }
    }
  });

  /* The `off` arm: the dump has to describe the fixture's own vitals, not the fixture's vitals
     with a toolbar running inside them. */
  await page.goto(`http://127.0.0.1:${PORT}/?d0bar=off`, { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);

  /* Real clicks, so the browser produces `event` entries carrying interaction ids. Synthetic
     dispatch never reaches INP. */
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.click(200 + i * 10, 300);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);

  const dump = await page.evaluate(() => ({
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ...window.__vitalsDump,
  }));

  await browser.close();

  const counts = Object.entries(dump)
    .filter(([, value]) => Array.isArray(value))
    .map(([type, value]) => `${type} ${value.length}`)
    .join(", ");

  writeFileSync(OUT, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(`recorded ${counts} -> ${OUT}`);
} finally {
  server.kill();
}
