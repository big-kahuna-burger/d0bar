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
    /* Tier 4 adopts the host's OpenTelemetry SDK; it never installs one, and it never carries
       one. The API is read off a global the host registered, so an import of an
       `@opentelemetry/*` package here would mean the toolbar had started shipping the very
       thing it promises not to add — to every host, including the overwhelming majority with
       no SDK at all. See `src/collector/otel.ts`.

       Placed BEFORE the stage-1 block on purpose. Flat config replaces a rule's options
       rather than merging them, so of two blocks matching the same file the later one wins
       outright — with this block second, it silently switched off the stage-boundary guard
       for every file under `src/collector/`. Verified by making each violation and watching
       it be reported. */
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@opentelemetry/*", "@opentelemetry"],
              message:
                "d0bar adopts the host's OTel SDK and never bundles one. Read the API off the registered global instead — see src/collector/otel.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    /* Stage 1 is the critical path. Nothing from a later stage may be reachable from it
       by a static import, or the bundler pulls that stage into the load-phase bundle.

       This block matches a subset of the one above and therefore replaces it wholesale for
       these files, which is why the OTel ban is restated here rather than inherited. */
    files: ["src/collector/**/*.ts", "src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/panel/**", "**/trace/**", "**/auth/**", "**/worker/**"], message: "Stage 1 must not statically import a later stage. Use a dynamic import()." },
            /* Repeated from the `src/**` block above, deliberately — see the note there. Flat config
               rule's options rather than merging them, so the later, broader block would
               otherwise take this one's place for these files and silently switch the
               stage-boundary guard off. Both patterns have to be in whichever block wins. */
            { group: ["@opentelemetry/*", "@opentelemetry"], message: "d0bar adopts the host's OTel SDK and never bundles one. See src/collector/otel.ts." },
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
