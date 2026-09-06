import { defineConfig } from "@playwright/test";

/**
 * The observer-effect budget is a correctness test, not a nicety, so it runs serially on
 * one worker: two arms of the same fixture compared against each other cannot share a
 * machine with other tests without the comparison becoming noise.
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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
