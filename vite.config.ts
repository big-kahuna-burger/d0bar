import { defineConfig, type Plugin } from "vite";
import { minify, type MinifyOptions } from "terser";

/**
 * Stage 1 is the only thing on a host page's critical path, so it is built alone and
 * measured alone (see `.size-limit.json`). Stage 2 and 3 arrive as separate entries once
 * they exist; IIFE output cannot code-split, so each stage builds as its own bundle.
 */

/** The IIFE build's global: Rollup's `output.name`, and what the build guard checks for. */
const GLOBAL_NAME = "D0bar";

/**
 * A *fresh* options object per terser call, and it must stay that way.
 *
 * `minify()` normalises its argument in place, writing resolved defaults into the nested
 * `compress` and `mangle` objects. Sharing one literal across the two formats therefore
 * leaks the ES pass's `module: true` — which implies `toplevel` — into the IIFE pass, where
 * `toplevel` deletes the `var D0bar = …` binding as an unused top-level variable and takes
 * the script-tag build's entire public API with it.
 *
 * Deliberately unannotated: terser's own `MinifyOptions` and Vite's re-declared
 * `Terser.MinifyOptions` are structurally incompatible under `exactOptionalPropertyTypes`,
 * and the inferred literal satisfies both.
 */
function terserOptions() {
  return {
    compress: { passes: 2, unsafe_arrows: true, pure_getters: true },
    mangle: { properties: { regex: "^_" } },
  };
}

/**
 * Minification for both library outputs, because Vite's own handling is wrong for each of
 * them in a different way.
 *
 * For `es`, Vite skips terser entirely in library mode:
 *
 *   if (config.build.lib && outputOptions.format === "es") return null;
 *
 * (`vite/dist/node/chunks/dep-*.js`, in `terserPlugin`.) The assumption is that a library's
 * ESM output is always fed to a consumer's bundler, which will minify it. That assumption
 * does not hold here: d0bar publishes a size claim about what it costs a host page, and its
 * ESM build can be loaded directly by a `<script type="module">`.
 *
 * For `iife`, Vite passes terser an explicit `toplevel`, which deletes the
 * `var D0bar = (function(exports){…})({})` binding as an unused top-level variable — taking
 * the entire public API of the script-tag build with it. Rollup emits the binding correctly;
 * it does not survive Vite's terser invocation. Measured: with our options alone the global
 * is kept, and with `toplevel` passed at all it is dropped.
 *
 * So `build.minify` is off and both formats are minified here, with options we control.
 */
function minifyLibOutput(options: () => MinifyOptions, expectedGlobal: string | null): Plugin {
  return {
    name: "d0bar:minify-lib",
    enforce: "post",
    async renderChunk(code, _chunk, outputOptions) {
      const format = outputOptions.format;
      if (format !== "es" && format !== "iife") return null;

      const result = await minify(code, {
        ...options(),
        module: format === "es",
        sourceMap: Boolean(outputOptions.sourcemap),
      });
      if (!result.code) return null;

      /* The script-tag build's only public surface is its global. A minifier that removes it
         produces a bundle that still loads, still auto-starts, and cannot be torn down — a
         failure with no symptom until a host tries to call `destroy()`. Fail the build.

         Which global to expect is per artifact, because they genuinely differ: stage 1 must
         expose `D0bar`, the importable worker module must expose `D0barSW` for the classic
         `importScripts` path, and the standalone worker exposes nothing at all — it is a
         side-effecting entry with no callers. `null` states that third case explicitly
         rather than letting the check quietly not apply, so a future entry that forgets to
         declare a global fails here instead of shipping without one. */
      if (format === "iife" && expectedGlobal !== null) {
        if (!new RegExp(`\\b${expectedGlobal}\\s*=`).test(result.code)) {
          throw new Error(
            `d0bar: minification dropped the \`${expectedGlobal}\` global from the IIFE build. ` +
              `That build has no other way to expose its API.`,
          );
        }
      }

      /* Tier 4's central claim is that d0bar ships no OpenTelemetry code: it reads a provider
         the host already registered, and a page without an SDK pays nothing. An ESLint rule
         bans the import, but lint is not what ships — a transitive dependency, a type import
         that stops being type-only, or a stray `require` would all land here with the rule
         still green. Checked against the emitted bytes, which is the only place the claim is
         actually true or false. Verified by hand this run: 0 occurrences in all artifacts. */
      if (/@opentelemetry\//.test(result.code)) {
        throw new Error(
          "d0bar: the bundle contains `@opentelemetry/` — tier 4 adopts the host's SDK and " +
            "must never ship one. Something imported an OpenTelemetry package.",
        );
      }

      return { code: result.code, map: null };
    },
  };
}

/**
 * Two builds, selected by `D0BAR_STAGE`.
 *
 * Stage 2 is a separate artifact rather than a Rollup chunk because IIFE output cannot
 * code-split: a static `import("../panel")` would emit a chunk for the ES build and be
 * silently inlined back into the IIFE one, putting the panel on the critical path with no
 * error to notice. So stage 2 builds alone, as an ES module, and stage 1 loads it by URL.
 */
const stage: 1 | 2 | "sw" | "worker" =
  process.env.D0BAR_STAGE === "2"
    ? 2
    : process.env.D0BAR_STAGE === "sw"
      ? "sw"
      : process.env.D0BAR_STAGE === "worker"
        ? "worker"
        : 1;

/**
 * The service worker is a third artifact for the same reason stage 2 is a second one: it is
 * a separate realm with a separate entry point, and nothing about it may be inlined into the
 * page bundle. It ships in two shapes — the standalone worker a host registers by path, and
 * the module a host imports into a worker they already own.
 *
 * The standalone one is IIFE, not ESM. A module service worker needs `{ type: "module" }` at
 * registration and is still unsupported in Firefox and Safari, and the worker is the tier
 * whose absence the toolbar has to *report* — shipping it in a format a third of browsers
 * cannot register would manufacture the degraded state this change exists to avoid.
 */
const SW_ENTRIES = {
  standalone: { entry: "src/sw/d0bar-sw.ts", file: "d0bar-sw.js" },
  module: { entry: "src/sw/module.ts", file: "d0bar-sw-module.js" },
} as const;

const swVariant = process.env.D0BAR_SW === "module" ? "module" : "standalone";

/**
 * Whether this is a watch build.
 *
 * Read from argv rather than from the resolved config: Vite sets `build.watch` from the CLI
 * flag *after* this config module is evaluated, so by the time it exists it is too late to
 * decide whether the output directory may be emptied.
 */
const watching = process.argv.includes("--watch") || process.argv.includes("-w");

export default defineConfig(({ mode }) => ({
  /* Read from Vite's own mode rather than process.env.NODE_ENV, which is not yet set to
     "production" when this config module is evaluated — the earlier form shipped the
     development assertions in a production build. */
  define: {
    __DEV__: JSON.stringify(mode !== "production"),
  },
  plugins: [
    minifyLibOutput(
      terserOptions,
      stage === "sw"
        ? swVariant === "module"
          ? "D0barSW"
          : null
        : /* The layout worker builds ESM only, so the IIFE guard never runs for it; `null`
             states that rather than leaving a global name that would silently not apply. */
          stage === "worker"
          ? null
          : GLOBAL_NAME,
    ),
  ],
  build: {
    target: "es2022",
    /* Only stage 1 clears the directory; the others build into it afterwards — and never
       while watching.

       `pnpm dev` runs every stage's watcher against one `dist/`, so a stage-1 rebuild that
       emptied the directory would delete `d0bar.panel.js` out from under the running page.
       The symptom was the whole panel: the pill's click `import()`s stage 2 by URL, got a
       404, and swallowed it — a toolbar that looked alive and did nothing when clicked. */
    emptyOutDir: stage === 1 && !watching,
    lib:
      /**
       * A fourth artifact, and a fourth realm. The layout worker is loaded by the panel with
       * `new Worker(url, { type: "module" })` from the panel's own directory, so it must exist
       * as a file at a stable name — a Rollup chunk of stage 2 would be inlined into stage 2
       * and never be a worker at all.
       *
       * ESM only, unlike the service worker. A *dedicated* module worker is supported
       * everywhere the panel already needs (Chrome 80, Firefox 114, Safari 15); the
       * `{ type: "module" }` gap that forced the service worker to IIFE is a service-worker
       * gap. And the fallback here would be no waterfall rather than no toolbar.
       */
      stage === "worker"
        ? {
            entry: "src/worker/layout.worker.ts",
            formats: ["es"],
            fileName: () => "d0bar-layout-worker.js",
          }
        : stage === "sw"
          ? {
              entry: SW_ENTRIES[swVariant].entry,
              /* A global for the classic-`importScripts` path, which has no export binding. */
              name: "D0barSW",
              formats: swVariant === "module" ? ["es", "iife"] : ["iife"],
              fileName: (format: string) =>
                format === "es"
                  ? SW_ENTRIES[swVariant].file.replace(/\.js$/, ".mjs")
                  : SW_ENTRIES[swVariant].file,
            }
          : stage === 2
            ? {
                entry: "src/panel/index.ts",
                /* ES only. Stage 2 is always reached through `import()`, from either build. */
                formats: ["es"],
                fileName: () => "d0bar.panel.js",
              }
            : {
                entry: "src/index.ts",
                name: GLOBAL_NAME,
                formats: ["es", "iife"],
                fileName: (format) => (format === "es" ? "d0bar.js" : "d0bar.iife.js"),
              },
    rollupOptions: {
      output: { compact: true },
    },
    /* Handled by `minifyLibOutput` for both formats — see the note there. Vite's own terser
       pass drops the IIFE global. */
    minify: false,
    /* `pill.css` is imported with `?inline`, so it travels through Vite's CSS pipeline and
       is minified there rather than shipping as an indented string inside the bundle.
       Stated explicitly instead of relying on it tracking `build.minify`. */
    cssMinify: "esbuild",
    reportCompressedSize: true,
  },
}));
