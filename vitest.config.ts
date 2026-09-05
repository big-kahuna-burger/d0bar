import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __DEV__: "true" },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    /* `node` by default, deliberately: the collector must not depend on a DOM existing, and a
       global jsdom would hide an accidental `document` reference in code that runs before the
       panel loads. Files that genuinely need a DOM opt in with
       `// @vitest-environment jsdom`. */
    environment: "node",
  },
});
