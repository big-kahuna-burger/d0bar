/**
 * Bundles the fixture's OpenTelemetry host.
 *
 * `bench/fixtures/otel/entry.js` imports two real OpenTelemetry packages, which a browser
 * cannot resolve from `node_modules` on its own. esbuild is used directly rather than adding
 * a fourth Vite config: this output is the instrument, it is never shipped, and giving it a
 * stage in the real build would put it one careless edit away from being one.
 *
 * Output is `bench/fixtures/host/otel-sdk.js`, an IIFE exposing `OtelFixture`. Regenerated
 * on every `pnpm test:perf` rather than committed — a stale bundle of someone else's SDK is
 * exactly the kind of thing that gets debugged for an hour.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "bench/fixtures/otel/entry.js")],
  outfile: join(root, "bench/fixtures/host/otel-sdk.js"),
  bundle: true,
  format: "iife",
  globalName: "OtelFixture",
  platform: "browser",
  target: "es2022",
  /* Not minified. When this fixture disagrees with the panel the next question is always
     "what did the SDK actually do", and a readable bundle answers it in the debugger. */
  minify: false,
  logLevel: "warning",
});

console.log("built bench/fixtures/host/otel-sdk.js");
