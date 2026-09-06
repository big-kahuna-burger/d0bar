import { openDb, openFailed, resetDb } from "./db";
import { MAX_AGE_MS, MAX_RECORDS, STORE, type FetchRecord } from "./protocol";

/**
 * The worker's durable request log.
 *
 * Every function here is failure-tolerant by construction. This code runs inside a `fetch`
 * event handler on a page the toolbar is only observing, so a thrown error is not a bug
 * report — it is the toolbar breaking a customer's request. Storage can be denied outright
 * (private browsing, a blocked origin), fill up mid-session, or be evicted underneath us,
 * and none of those may surface as anything but a degraded reading.
 */

/** Latched on the first quota failure. Logging stops; the reading side reports it. */
let degraded = false;

export function loggingDegraded(): boolean {
  /* Two independent ways to be degraded: the database would not open at all, which `db.ts`
     latches, or a write hit quota, which is latched here. Either one means the log is not a
     complete record and the panel must not present it as one. */
  return degraded || openFailed();
}

function open(): Promise<IDBDatabase | undefined> {
  return openDb();
}

/**
 * Appends one record. Never rejects: a storage failure degrades logging and is reported
 * through {@link loggingDegraded}, because the alternative is an unhandled rejection inside
 * a `fetch` handler that is observing someone else's request.
 */
export async function append(record: FetchRecord): Promise<void> {
  if (degraded) return;
  const database = await open();
  if (!database) return;

  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = database.transaction(STORE, "readwrite");
    } catch {
      degraded = true;
      resolve();
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => {
      /* `QuotaExceededError` is the expected one; anything else that aborts a write is
         equally a reason to stop, and for the same reason — the log is no longer complete,
         so it must not be presented as if it were. */
      degraded = true;
      resolve();
    };
    tx.onerror = () => {
      degraded = true;
      resolve();
    };
    try {
      tx.objectStore(STORE).put(record);
    } catch {
      degraded = true;
      resolve();
    }
  });
}

/** Reads every retained record in insertion order. Used by the page, after settle. */
export async function readAll(): Promise<FetchRecord[]> {
  const database = await open();
  if (!database) return [];

  return new Promise<FetchRecord[]>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as FetchRecord[]) ?? []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Drops records past either bound. Called on `activate`, not per write: pruning on every
 * request would put a second transaction in the path of every fetch the page makes.
 */
export async function prune(now: number = Date.now()): Promise<void> {
  const database = await open();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();

      /* Age first: it is a straight range delete on the index and usually removes most of
         what the count bound would have had to walk. */
      const cutoff = now - MAX_AGE_MS;
      store.index("at").openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
          return;
        }
        /* Then count, oldest first, once the age pass has settled. */
        const counter = store.count();
        counter.onsuccess = () => {
          let excess = counter.result - MAX_RECORDS;
          if (excess <= 0) return;
          store.openCursor().onsuccess = (inner) => {
            const oldest = (inner.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!oldest || excess <= 0) return;
            oldest.delete();
            excess -= 1;
            oldest.continue();
          };
        };
      };
    } catch {
      resolve();
    }
  });
}

/** Test seam. The connection itself lives in `db.ts`, so its reset is `resetDb()`. */
export function resetLog(): void {
  resetDb();
  degraded = false;
}
