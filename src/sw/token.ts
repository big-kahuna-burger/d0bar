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

export type TokenSource = "none" | "session" | "stored";

/**
 * What the page is allowed to know.
 *
 * `hint` is the last four characters, for telling two pasted tokens apart in the UI. Dash0's
 * own `dash0.auth.token` span attribute records the last seven digits for exactly this purpose,
 * so the shape is theirs rather than invented here — four rather than seven because this one is
 * rendered next to a connect button and has no other job.
 */
export interface TokenStatus {
  connected: boolean;
  source: TokenSource;
  hint: string;
}

/** The last four characters, or `""`. Short tokens yield `""` rather than most of themselves. */
function hintOf(token: string): string {
  return token.length > 8 ? token.slice(-4) : "";
}

export function status(): TokenStatus {
  return { connected: held !== "", source, hint: hintOf(held) };
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
export async function set(token: string, persist: boolean): Promise<TokenStatus> {
  held = token.trim();
  source = held === "" ? "none" : persist ? "stored" : "session";

  if (held === "") {
    await removeStored();
    return status();
  }
  /* Switching to session-only removes an earlier persisted copy. Otherwise choosing the safer
     mode would leave the less safe copy behind it, which is the opposite of what was asked. */
  if (persist) await putStored(held);
  else await removeStored();

  return status();
}

/** Clears both locations. Neither is authoritative, so both have to go. */
export async function clear(): Promise<TokenStatus> {
  held = "";
  source = "none";
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
  const stored = await readStored();
  if (stored !== "") {
    held = stored;
    source = "stored";
  }
  return status();
}

/** Test seam. Resets the module's realm-scoped state without touching the store. */
export function resetMemory(): void {
  held = "";
  source = "none";
}

/* ── the persisted copy ───────────────────────────────────────────────────────────────────
   Its own object store in the existing database rather than a second database: the worker
   already opens `d0bar`, and a second connection is a second `onupgradeneeded` to keep in
   step with this one. */

const KEY = "auth";

/* Storage can be denied outright — a partitioned context, or a browser configured to block
   site data. `openDb()` resolves `undefined` rather than throwing, and every caller below
   treats that as "not persisted", which is a real state and not an error to throw at the user
   mid-paste. */
const open = openDb;

async function putStored(token: string): Promise<void> {
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
    tx.objectStore(TOKEN_STORE).put(token, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function readStored(): Promise<string> {
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
    const request = tx.objectStore(TOKEN_STORE).get(KEY);
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
    tx.objectStore(TOKEN_STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
