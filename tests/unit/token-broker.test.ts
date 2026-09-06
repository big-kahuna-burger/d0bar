// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../../src/sw/db";
import type { BrokerReply } from "../../src/shared/broker";
import { handle } from "../../src/sw/messages";
import { allowed } from "../../src/sw/query";
import { DB_NAME, DB_VERSION, TOKEN_STORE } from "../../src/sw/protocol";
import { clear, resetMemory, restore, set, status } from "../../src/sw/token";

/**
 * The pasted-token broker.
 *
 * The property under test is a negative one and it is the whole point: **no message returns the
 * token**. Everything else here is in service of that, or of the allowlist that decides where
 * the token is allowed to go.
 *
 * What is deliberately *not* asserted is that the persisted token is hidden from the page. It
 * is not, and no test should imply otherwise — IndexedDB is per-origin, the page opens the same
 * database, and tier 2 depends on exactly that. The custody guarantee lives in the session-only
 * mode, asserted below by reading the store the way the host page would and finding the token
 * absent — never written, and an earlier persisted copy removed when the safer mode is chosen.
 */

const API = "https://api.eu-west-1.aws.dash0.com";
const TOKEN = "auth_0123456789abcdefwxyz";
const REGION = "prod:eu-west-1";

/**
 * Reads the persisted copy the way the *host page* would.
 *
 * Not through `token.ts` — deliberately. The page opens this database too, because IndexedDB is
 * per-origin, and that is exactly the fact this change stopped pretending otherwise about. So
 * the assertions below check the store from outside the module that owns it, which is both the
 * stronger test and an honest depiction of who can look.
 */
async function stored(): Promise<string | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const value = await new Promise<unknown>((resolve) => {
    const request = db.transaction(TOKEN_STORE, "readonly").objectStore(TOKEN_STORE).get("auth");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  db.close();
  return typeof value === "string" ? value : undefined;
}

function collector() {
  const replies: BrokerReply[] = [];
  return { replies, postMessage: (message: BrokerReply) => replies.push(message) };
}

/** Everything the worker could hand back, flattened to strings. */
function textOf(value: unknown): string {
  return JSON.stringify(value);
}

beforeEach(async () => {
  resetDb();
  resetMemory();
  await clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the page can learn", () => {
  it("never returns the token, for any message", async () => {
    const reply = collector();
    await handle({ kind: "connect", token: TOKEN, persist: false, region: REGION }, reply);
    await handle({ kind: "status" }, reply);
    await handle({ kind: "disconnect" }, reply);

    expect(reply.replies).toHaveLength(3);
    for (const message of reply.replies) {
      expect(textOf(message), `a reply carried the token: ${textOf(message)}`).not.toContain(
        TOKEN,
      );
    }
  });

  it("reports connection, source and a four-character hint and nothing else", async () => {
    await set(TOKEN, false, REGION);
    const reading = status();
    expect(reading).toEqual({
      connected: true,
      source: "session",
      hint: "wxyz",
      apiOrigin: API,
    });
    /* The shape is the guarantee: four fields, and the token is not derivable from any of
       them. A fifth field added later has to face this assertion. */
    expect(Object.keys(reading).sort()).toEqual(["apiOrigin", "connected", "hint", "source"]);
  });

  it("gives no hint at all for a token short enough to be exposed by one", async () => {
    await set("auth_1", false, REGION);
    expect(status().hint).toBe("");
  });

  it("ignores an unknown message rather than answering it", async () => {
    const reply = collector();
    /* A page probing for a message that returns the token must learn nothing from the shape of
       the silence — no echo, no error naming what it asked for. */
    await handle({ kind: "give-me-the-token" }, reply);
    await handle({ kind: "connect" }, reply);
    await handle("status", reply);
    await handle(null, reply);
    expect(reply.replies).toHaveLength(0);
  });
});

describe("custody", () => {
  it("never writes the token to a store in session-only mode", async () => {
    /* The one real guarantee this change offers, stated precisely. The first version of this
       test asserted that session-only opens no database at all, and it failed — because
       choosing session-only after having persisted has to *delete* the earlier copy, which
       means opening the store. The guarantee is about writing, not about touching. */
    await set(TOKEN, false, REGION);
    expect(status()).toMatchObject({ connected: true, source: "session" });
    expect(await stored()).toBeUndefined();
  });

  it("removes an earlier persisted copy when the safer mode is chosen", async () => {
    await set(TOKEN, true, REGION);
    expect(await stored()).toBe(TOKEN);

    await set(TOKEN, false, REGION);
    /* Otherwise choosing session-only would be the option that leaves a credential on disk. */
    expect(await stored(), "the persisted copy outlived the choice to stop persisting").toBe(
      undefined,
    );
  });

  it("removes the persisted copy on disconnect", async () => {
    await set(TOKEN, true, REGION);
    await clear();
    expect(await stored()).toBeUndefined();
  });

  it("reports disconnected once cleared", async () => {
    await set(TOKEN, false, REGION);
    expect(status().connected).toBe(true);
    await clear();
    expect(status()).toEqual({ connected: false, source: "none", hint: "", apiOrigin: "" });
  });

  it("survives a worker restart when persisted, and does not when not", async () => {
    await set(TOKEN, true, REGION);
    expect(status().source).toBe("stored");

    /* A terminated worker loses its realm. `restore()` is what a revived one calls, and
       without it the user is told they are disconnected while the token is still on disk. */
    resetMemory();
    expect(status().connected).toBe(false);
    expect((await restore()).source).toBe("stored");

    /* The same restart with a session-only token correctly finds nothing. */
    await set(TOKEN, false, REGION);
    resetMemory();
    expect((await restore()).connected).toBe(false);
  });
});

describe("which region", () => {
  it("resolves the id to an origin and reports it back", async () => {
    expect((await set(TOKEN, false, "prod:us-west-2")).apiOrigin).toBe(
      "https://api.us-west-2.aws.dash0.com",
    );
  });

  it("refuses an id the compiled table does not carry", async () => {
    /* The refusal is the security property. A page that could name its own origin — directly,
       or by way of an id the worker resolved from something the page sent — could have the
       token attached to a request it receives. Choosing from a fixed table cannot do that. */
    const reading = await set(TOKEN, false, "evil-region-1");
    expect(reading.connected).toBe(false);
    expect(reading.apiOrigin).toBe("");
  });

  it("does not connect to the previous region when a later id is refused", async () => {
    await set(TOKEN, false, REGION);
    await set(TOKEN, false, "evil-region-1");
    /* Otherwise a refused region would leave the token live against whatever was selected
       before, which is a connection the user did not ask for. */
    expect(status().connected).toBe(false);
  });

  it("sends a query to the connected region and refuses every other", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await set(TOKEN, false, "prod:us-west-2");
    const reply = collector();

    await handle({ kind: "query", url: `${API}/api/spans` }, reply);
    expect(reply.replies[0]).toEqual({
      kind: "query",
      outcome: { ok: false, reason: "refused-origin" },
    });

    await handle({ kind: "query", url: "https://api.us-west-2.aws.dash0.com/api/spans" }, reply);
    expect((reply.replies[1] as { outcome: { ok: boolean } }).outcome.ok).toBe(true);
  });

  it("restores the region alongside the token after a worker restart", async () => {
    await set(TOKEN, true, "prod:us-west-2");
    resetMemory();
    /* The token surviving without its region would restore a credential aimed at the default
       region — a silent 401 that reads exactly like a revoked token. */
    expect((await restore()).apiOrigin).toBe("https://api.us-west-2.aws.dash0.com");
  });
});

describe("where the token may go", () => {
  const cases: Array<[string, string, boolean]> = [
    ["the configured origin", `${API}/api/spans?limit=1`, true],
    ["the same origin on a different path", `${API}/api/logs`, true],
    ["a lookalike suffix", "https://api.eu-west-1.aws.dash0.com.evil.test/api/spans", false],
    ["a userinfo prefix", "https://api.eu-west-1.aws.dash0.com@evil.test/api/spans", false],
    ["plain http on the same host", "http://api.eu-west-1.aws.dash0.com/api/spans", false],
    ["a different region", "https://api.us-west-2.aws.dash0.com/api/spans", false],
    ["an opaque origin", "blob:whatever", false],
    ["nonsense", "not a url", false],
  ];

  for (const [name, url, expected] of cases) {
    it(`${expected ? "allows" : "refuses"} ${name}`, () => {
      expect(allowed(url, API)).toBe(expected);
    });
  }

  it("compares parsed origins, not string prefixes", () => {
    /* The lookalike above satisfies `startsWith(API)`. That is the whole reason this function
       exists rather than a comparison written inline at the call site. */
    const lookalike = "https://api.eu-west-1.aws.dash0.com.evil.test/api/spans";
    expect(lookalike.startsWith(API)).toBe(true);
    expect(allowed(lookalike, API)).toBe(false);
  });
});

describe("query outcomes", () => {
  it("refuses a foreign origin without reaching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await set(TOKEN, false, REGION);

    const reply = collector();
    await handle({ kind: "query", url: "https://evil.test/api/spans" }, reply);

    expect(reply.replies[0]).toEqual({
      kind: "query",
      outcome: { ok: false, reason: "refused-origin" },
    });
    expect(fetchSpy, "a refused origin must not be fetched").not.toHaveBeenCalled();
  });

  it("names a rejected token separately from an unreachable API", async () => {
    await set(TOKEN, false, REGION);
    const reply = collector();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await handle({ kind: "query", url: `${API}/api/spans` }, reply);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    await handle({ kind: "query", url: `${API}/api/spans` }, reply);

    /* Two different problems with two different fixes. Folding them together would leave a
       user with a revoked token looking at their network. */
    expect(reply.replies.map((m) => (m as { outcome: { reason?: string } }).outcome.reason)).toEqual(
      ["rejected", "unreachable"],
    );
  });

  it("says not-connected rather than making an unauthenticated call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reply = collector();
    await handle({ kind: "query", url: `${API}/api/spans` }, reply);

    expect(reply.replies[0]).toEqual({
      kind: "query",
      outcome: { ok: false, reason: "not-connected" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the bearer, omits credentials, and puts the token nowhere else", async () => {
    await set(TOKEN, false, REGION);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const reply = collector();
    await handle({ kind: "query", url: `${API}/api/spans` }, reply);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/spans`);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    /* `access-control-allow-origin: *` and a credentialed request are mutually exclusive — the
       browser rejects the response outright, so this is a correctness constraint and not a
       preference. */
    expect(init.credentials).toBe("omit");
    /* And the reply carries the body, not the credential that fetched it. */
    expect(textOf(reply.replies[0])).not.toContain(TOKEN);
  });
});
