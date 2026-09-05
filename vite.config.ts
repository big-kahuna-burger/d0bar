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
function minifyLibOutput(options: () => MinifyOptions): Plugin {
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
         failure with no symptom until a host tries to call `destroy()`. Fail the build. */
      if (format === "iife" && !new RegExp(`\\b${GLOBAL_NAME}\\s*=`).test(result.code)) {
        throw new Error(
          `d0bar: minification dropped the \`${GLOBAL_NAME}\` global from the IIFE build. ` +
            `The script-tag build has no other way to expose init/destroy.`,
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
const stage = process.env.D0BAR_STAGE === "2" ? 2 : 1;

export default defineConfig(({ mode }) => ({
  /* Read from Vite's own mode rather than process.env.NODE_ENV, which is not yet set to
     "production" when this config module is evaluated — the earlier form shipped the
     development assertions in a production build. */
  define: {
    __DEV__: JSON.stringify(mode !== "production"),
  },
  plugins: [minifyLibOutput(terserOptions)],
  build: {
    target: "es2022",
    /* Only stage 1 clears the directory; stage 2 builds into it afterwards. */
    emptyOutDir: stage === 1,
    lib:
      stage === 2
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
