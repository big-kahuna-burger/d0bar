import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "design_handoff_d0bar", "src/collector/tokens.gen.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, __DEV__: "readonly" },
    },
  },
  {
    /* Stage 1 is the critical path. Nothing from a later stage may be reachable from it
       by a static import, or the bundler pulls that stage into the load-phase bundle. */
    files: ["src/collector/**/*.ts", "src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/panel/**", "**/trace/**", "**/auth/**", "**/worker/**"], message: "Stage 1 must not statically import a later stage. Use a dynamic import()." },
          ],
        },
      ],
    },
  },
  {
    /* The service worker observes; it must never respond. */
    files: ["src/sw/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "event", property: "respondWith", message: "d0bar's worker observes without intercepting. respondWith() is forbidden." },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "bench/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
