import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordFor, resetOrder } from "../../src/sw/observe";

/**
 * Observation without interception, asserted two ways.
 *
 * The lint rule in `eslint.config.js` bans `respondWith` in `src/sw/**`, which covers the
 * source. It cannot cover a `respondWith` that arrives through a dependency, a generated
 * helper, or a future build step — so the shipped artifact is grepped as well. A property
 * this important is enforced by something that fails loudly, not by a comment saying it
 * holds.
 */

const BUNDLES = ["dist/d0bar-sw.js", "dist/d0bar-sw-module.js", "dist/d0bar-sw-module.mjs"];

describe("the shipped worker never intercepts", () => {
  for (const path of BUNDLES) {
    it(`${path} contains no respondWith`, () => {
      if (!existsSync(path)) {
        throw new Error(
          `${path} is missing. This assertion is about the shipped artifact, so it must not ` +
            `pass by default when the artifact was never built — run \`pnpm build\` first.`,
        );
      }
      const code = readFileSync(path, "utf8");
      expect(code).not.toContain("respondWith");
    });
  }

  it("dist/d0bar-sw.js still registers the fetch observer", () => {
    /* The complement of the ban: a worker that observes nothing would also contain no
       `respondWith`, and would pass the assertion above while doing nothing at all. */
    const code = readFileSync("dist/d0bar-sw.js", "utf8");
    expect(code).toContain('addEventListener("fetch"');
  });
});

describe("record extraction", () => {
  it("reads the traceparent off a request", () => {
    resetOrder();
    const request = new Request("https://x.test/api", {
      method: "POST",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });

    const record = recordFor(request, 1234);
    expect(record).toMatchObject({
      order: 0,
      method: "POST",
      at: 1234,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sampled: true,
    });
  });

  it("records a request with no traceparent as untraced rather than skipping it", () => {
    resetOrder();
    /* An untraced request is the Untraced tab's entire subject matter. Dropping it here
       would make the toolbar silently unable to report the thing it most wants to. */
    const record = recordFor(new Request("https://x.test/api"), 1);
    expect(record.traceId).toBe("");
    expect(record.url).toBe("https://x.test/api");
  });

  it("assigns issue order monotonically", () => {
    resetOrder();
    const a = recordFor(new Request("https://x.test/1"));
    const b = recordFor(new Request("https://x.test/2"));
    expect(b.order).toBe(a.order + 1);
  });
});
