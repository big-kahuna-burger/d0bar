import type { TokenSource, TokenStatus } from "../shared/broker";
import { DEFAULT_REGION, originFor } from "../shared/regions";
import { openDb } from "./db";
import { TOKEN_STORE } from "./protocol";

/**
 * Custody for the pasted Dash0 auth token.
 *
 * **Read the honest version of the guarantee before changing anything here.** A service worker
 * cannot keep a secret from its own page: IndexedDB is keyed by origin, not by realm, and the
 * page opens the same database this file writes — `protocol.ts` says so, and tier 2 depends on
 * it. So `persist: true` means "the host page can read this token if it goes looking", and the
 * UI has to say that rather than imply custody nobody has.
 *
 * `persist: false` is the mode with a real guarantee. `held` below lives in the worker's global
 * scope, which is a realm the page has no handle to at all — no store, no key, no message that
 * returns it. Its cost is the service worker lifecycle: an idle worker is terminated and `held`
 * goes with it.
 *
 * What makes the guarantee structural rather than careful: **nothing exported from this module
 * returns the token except `bearer()`**, and `bearer()` is consumed only by `query.ts`, which
 * puts it in a header and never in a reply. `status()` is what the page gets, and it cannot be
 * made to leak by asking differently, because the token is not in the object it builds.
 */

/** The session-only copy. The page has no handle to this realm. */
let held = "";

/** Where the current token came from, for `status()`. Never inferred at read time. */
let source: TokenSource = "none";

/**
 * The region id the token was connected for.
 *
 * Held next to the token because it is part of the credential's meaning: a token for one region
 * is not a token for another, and sending it to the wrong one would leak it to an origin the
 * user never chose. Stored as the *id*; the origin is derived from the compiled table on every
 * read, so a persisted value cannot smuggle an origin in.
 */
let region = DEFAULT_REGION;

/** The last four characters, or `""`. Short tokens yield `""` rather than most of themselves. */
function hintOf(token: string): string {
  return token.length > 8 ? token.slice(-4) : "";
}

export function status(): TokenStatus {
  return {
    connected: held !== "",
    source,
    hint: hintOf(held),
    /* Resolved here, never stored. Whatever is on disk is an id, and an id that is no longer in
       the table resolves to `""` — a refusal — rather than to a stale origin. */
    apiOrigin: held === "" ? "" : originFor(region),
  };
}

/** The API origin the current token may be sent to, or `""`. Internal to `query.ts`. */
export function apiOrigin(): string {
  return originFor(region);
}

/**
 * The token itself, for the one caller that needs it.
 *
 * Deliberately not part of the message surface. `d0bar-sw.ts` never calls this; `query.ts` does,
 * and puts the result straight into a header.
 */
export function bearer(): string {
  return held;
}

/**
 * Stores a token.
 *
 * `persist` is the user's custody choice, and the guarantee is precise: **the token is never
 * written to a store in session-only mode**. It is not "no storage is touched" — an earlier
 * draft claimed that and its own test caught it. Choosing session-only after having persisted
 * must *delete* the earlier copy, which means opening the store to do it. Leaving it would make
 * the safer choice the one that leaves a credential on disk.
 */
export async function set(token: string, persist: boolean, regionId: string): Promise<TokenStatus> {
  /* Refused rather than defaulted. Falling back to a region the user did not pick would send
     their token somewhere they did not choose, which is the one mistake this argument exists to
     prevent.

     `clear()` rather than `status()`, and a test caught the difference: returning the current
     status left an earlier connection live, so a refused region reported "not connected" while
     the previous region's token was still being attached to queries. A refusal has to leave
     nothing connected. */
  if (originFor(regionId) === "") return clear();
  region = regionId;
  held = token.trim();
  source = held === "" ? "none" : persist ? "stored" : "session";

  if (held === "") {
    await removeStored();
    return status();
  }
  /* Switching to session-only removes an earlier persisted copy. Otherwise choosing the safer
     mode would leave the less safe copy behind it, which is the opposite of what was asked. */
  if (persist) await putStored(held, region);
  else await removeStored();

  return status();
}

/** Clears both locations. Neither is authoritative, so both have to go. */
export async function clear(): Promise<TokenStatus> {
  held = "";
  source = "none";
  region = DEFAULT_REGION;
  await removeStored();
  return status();
}

/**
 * Restores a persisted token after the worker restarts.
 *
 * Called once at startup. A worker that has been terminated and revived has an empty `held`,
 * and without this the user would be told they are disconnected while their token is still on
 * disk — a status that is wrong in the direction of asking for the credential again.
 */
export async function restore(): Promise<TokenStatus> {
  if (held !== "") return status();
  const stored = await readStored(KEY);
  if (stored !== "") {
    const storedRegion = await readStored(REGION_KEY);
    /* A persisted region that is no longer in the compiled table is not honoured — the token
       stays unrestored rather than being pointed at a default the user never chose. */
    if (originFor(storedRegion) === "") return status();
    held = stored;
    region = storedRegion;
    source = "stored";
  }
  return status();
}

/** Test seam. Resets the module's realm-scoped state without touching the store. */
export function resetMemory(): void {
  held = "";
  source = "none";
  region = DEFAULT_REGION;
}

/* ── the persisted copy ───────────────────────────────────────────────────────────────────
   Its own object store in the existing database rather than a second database: the worker
   already opens `d0bar`, and a second connection is a second `onupgradeneeded` to keep in
   step with this one. */

const KEY = "auth";
const REGION_KEY = "region";

/* Storage can be denied outright — a partitioned context, or a browser configured to block
   site data. `openDb()` resolves `undefined` rather than throwing, and every caller below
   treats that as "not persisted", which is a real state and not an error to throw at the user
   mid-paste. */
const open = openDb;

async function putStored(token: string, regionId: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(TOKEN_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(TOKEN_STORE);
    store.put(token, KEY);
    store.put(regionId, REGION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function readStored(key: string): Promise<string> {
  const db = await open();
  if (!db) return "";
  const value = await new Promise<string>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(TOKEN_STORE, "readonly");
    } catch {
      resolve("");
      return;
    }
    const request = tx.objectStore(TOKEN_STORE).get(key);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : "");
    request.onerror = () => resolve("");
  });
  /* Not closed: `openDb()` caches one connection for the whole worker, and closing it here
     would take the request log down with it. */
  return value;
}

async function removeStored(): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(TOKEN_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(TOKEN_STORE);
    store.delete(KEY);
    store.delete(REGION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
