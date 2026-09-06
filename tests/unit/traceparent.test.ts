import { describe, expect, it } from "vitest";
import { parseTraceparent } from "../../src/sw/protocol";

/**
 * `traceparent` parsing.
 *
 * This is the one field tier 2 exists to read, and the only place a trace id enters the
 * toolbar. Everything downstream — the trace jump, the untraced count, the `F_HAS_SPAN`
 * flag — is a consequence of what this function returns, so a header it accepts wrongly
 * becomes a trace id presented to the user with full confidence and no way to tell.
 *
 * The rule is therefore: parse, or return nothing. Never repair.
 */

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  it("reads a well-formed sampled header", () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("reads the sampled bit as false when it is clear", () => {
    expect(parseTraceparent(VALID.replace(/-01$/, "-00"))?.sampled).toBe(false);
  });

  it("reads only the low bit of the flags", () => {
    /* `fe` has the sampled bit clear despite being mostly ones — the other seven bits are
       reserved and must not be read as truthiness. */
    expect(parseTraceparent(VALID.replace(/-01$/, "-fe"))?.sampled).toBe(false);
    expect(parseTraceparent(VALID.replace(/-01$/, "-ff"))?.sampled).toBe(true);
  });

  it("normalises uppercase hex", () => {
    expect(parseTraceparent(VALID.toUpperCase())?.traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTraceparent(`  ${VALID}\t`)?.spanId).toBe("00f067aa0ba902b7");
  });

  describe("returns nothing rather than guessing", () => {
    const rejected: Array<[string, string | null]> = [
      ["absent", null],
      ["empty", ""],
      ["whitespace only", "   "],
      ["too few fields", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"],
      ["extra field on version 00", `${VALID}-extra`],
      ["forbidden version ff", VALID.replace(/^00/, "ff")],
      ["non-hex version", VALID.replace(/^00/, "0z")],
      ["short trace id", "00-4bf92f3577b34da6-00f067aa0ba902b7-01"],
      ["long trace id", "00-4bf92f3577b34da6a3ce929d0e0e4736aa-00f067aa0ba902b7-01"],
      ["non-hex trace id", "00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
      ["all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
      ["all-zero span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
      ["short span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01"],
      ["non-hex flags", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0g"],
      ["garbage", "not a traceparent at all"],
    ];

    for (const [name, header] of rejected) {
      it(name, () => {
        expect(parseTraceparent(header)).toBeUndefined();
      });
    }
  });

  it("accepts a future version with a well-formed body", () => {
    /* The spec requires later versions to remain parseable as
       `version-traceid-spanid-flags`, with fields possibly appended. Rejecting them would
       make the toolbar go dark the day a version 01 ships — reporting "untraced" for
       requests that are, in fact, traced. That is a worse failure than reading four fields
       out of five. */
    const future = `01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-something`;
    expect(parseTraceparent(future)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });
});
