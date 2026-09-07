import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __DEV__: "true" },
  test: {
    include: ["tests/**/*.test.ts"],
    /* `node` by default: the signals core must not depend on a DOM existing. Files that
       genuinely need one opt in with `// @vitest-environment jsdom`. */
    environment: "node",
  },
});
