import { defineConfig } from "@playwright/test";

/**
 * Two projects, because this directory holds two kinds of test and only one of them cares who
 * else is on the machine.
 *
 * The observer-effect budget is a correctness test, not a nicety: two arms of the same fixture
 * compared against each other cannot share a machine with anything without the comparison
 * becoming noise. That is seven tests, tagged `@timing`, and they run alone on one worker.
 *
 * The other sixty-odd assert ordering, DOM state, storage contents and console output. They
 * inherited the serial constraint from the seven and were paying for it: measured on CI,
 * 317 s of the suite is timing-sensitive and 158 s is not, and the second 158 s was running one
 * test at a time for no reason.
 *
 * Worker counts live in the scripts rather than here, because `workers` is a global option
 * that a project cannot override — `pnpm test:perf:timing` pins one, `pnpm test:perf:behaviour`
 * takes the machine. Running `pnpm test:perf` runs both serially, which is what a single
 * machine should do.
 */
export default defineConfig({
  testDir: "tests/perf",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [["list"], ["json", { outputFile: "bench/last-run.json" }]],
  use: {
    baseURL: "http://127.0.0.1:8732",
    trace: "off",
    video: "off",
  },
  webServer: {
    /* The OTel fixture's SDK bundle is rebuilt here rather than committed: it is a bundle of
       someone else's package, and a stale one is exactly the kind of thing that gets debugged
       for an hour. Cheap — esbuild, one entry point. */
    command: "node scripts/build-otel-fixture.mjs && node bench/fixtures/server.mjs",
    url: "http://127.0.0.1:8732/health",
    /* Never reuse locally: the fixture server is part of what the tests measure, so a
       process left over from before a fixture edit silently serves the old routes. That
       cost a debugging cycle chasing a 404 that looked like a browser cache limitation. */
    reuseExistingServer: false,
    stdout: "ignore",
  },
  projects: [
    /* Alone on the machine. `ab.spec.ts` is 228 s of this on its own. */
    {
      name: "timing",
      grep: /@timing/,
      fullyParallel: false,
      use: { browserName: "chromium" },
    },
    /* Everything else. Nothing here compares two durations against each other. */
    {
      name: "behaviour",
      grepInvert: /@timing/,
      fullyParallel: true,
      use: { browserName: "chromium" },
    },
  ],
});
