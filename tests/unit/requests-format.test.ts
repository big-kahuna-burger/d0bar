import { describe, expect, it } from "vitest";
import {
  accessibleName,
  displayPath,
  formatDuration,
  hasTrace,
  isXhr,
  statusFor,
} from "../../src/panel/views/requests/format";
import { scratch, type RequestRecord } from "../../src/shared/record";
import { F_HAS_SPAN, F_STATUS_UNKNOWN, F_XHR } from "../../src/shared/flags";

const ORIGIN = "https://app.example.com";

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  const base = scratch();
  Object.assign(base, {
    url: `${ORIGIN}/api/shipments?status=open`,
    duration: 412,
    status: 200,
    method: "GET",
  });
  return Object.assign(base, over);
}

describe("duration", () => {
  it("uses milliseconds below a second and seconds above it", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(999.4)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1240)).toBe("1.24s");
  });
});

describe("status", () => {
  it("renders nothing at all when the browser did not expose one", () => {
    /* Not a dash and not a zero. Both would be claims about a response the toolbar never
       saw the status of — see the `F_STATUS_UNKNOWN` note in `ring.ts`. */
    expect(statusFor(record({ flags: F_STATUS_UNKNOWN, status: 0 }))).toEqual({
      text: "",
      tone: "unknown",
    });
  });

  it("separates a 304 from the 2xx it is not, and a 4xx from the 5xx it is not", () => {
    expect(statusFor(record({ status: 200 })).tone).toBe("healthy");
    expect(statusFor(record({ status: 304 })).tone).toBe("subtle");
    expect(statusFor(record({ status: 404 })).tone).toBe("warn");
    expect(statusFor(record({ status: 503 })).tone).toBe("error");
  });
});

describe("the request's display name", () => {
  it("drops the origin only when it is the page's own", () => {
    expect(displayPath(`${ORIGIN}/api/shipments?status=open`, ORIGIN)).toBe(
      "/api/shipments?status=open",
    );
    /* On a third party the host *is* the identifying part: two CDNs must not read as one. */
    expect(displayPath("https://cdn.stripe.com/v3", ORIGIN)).toBe("cdn.stripe.com/v3");
  });

  it("shows an unparseable URL as it stands rather than dropping the row's identity", () => {
    expect(displayPath("data:text/plain,hi", ORIGIN)).toBe("data:text/plain,hi");
  });
});

describe("markers", () => {
  it("marks XHR and nothing else", () => {
    expect(isXhr(record({ flags: F_XHR }))).toBe(true);
    expect(isXhr(record())).toBe(false);
  });

  it("reports trace context only where one was actually observed", () => {
    expect(hasTrace(record({ flags: F_HAS_SPAN }))).toBe(true);
    expect(hasTrace(record())).toBe(false);
  });
});

describe("accessible name", () => {
  it("carries every column, including the absent ones", () => {
    expect(accessibleName(record({ flags: F_HAS_SPAN }), ORIGIN)).toBe(
      "GET, /api/shipments?status=open, status 200, 412ms, traced",
    );
  });

  it("states an unknown method and an unknown status rather than omitting them", () => {
    /* With tier 2 off the browser reports no method, so a screen reader must hear that it
       is unknown — an omitted field reads as a field that was not important. */
    const name = accessibleName(
      record({ method: "", flags: F_STATUS_UNKNOWN, status: 0 }),
      ORIGIN,
    );
    expect(name).toContain("method unknown");
    expect(name).toContain("status unknown");
    expect(name).toContain("no trace context");
  });
});
