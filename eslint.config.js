import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    /* `.claude/worktrees` holds agent worktrees — whole checkouts of this repo, `dist/`
       included. Without this, `eslint .` walks into them and lints a second copy of the
       project plus its build output, which is both meaningless and slow. */
    ignores: ["dist", ".claude", "design_handoff_d0bar", "src/collector/tokens.gen.ts"],
  },
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
    /* The service worker observes; it must never respond.

       `no-restricted-properties` keyed on `object: "event"` was the first form of this rule
       and it only matches that exact receiver — `const e = event; e.respondWith(...)` walks
       straight past it, and so does any handler that names its parameter something else. The
       syntax selector matches the property access whatever it is called, which is the
       property actually worth enforcing. The built bundle is grepped too, in
       `tests/unit/sw-observes.test.ts`: lint cannot see a `respondWith` that arrives through
       a dependency, and this ban has to hold for the artifact, not just the source. */
    files: ["src/sw/**/*.ts"],
    languageOptions: {
      globals: { ...globals.serviceworker, __DEV__: "readonly" },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='respondWith']",
          message:
            "d0bar's worker observes without intercepting: respondWith() would make the toolbar serve the request it is measuring. See src/sw/observe.ts.",
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "bench/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
