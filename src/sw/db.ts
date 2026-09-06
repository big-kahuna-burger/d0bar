import { DB_NAME, DB_VERSION, STORE, TOKEN_STORE } from "./protocol";

/**
 * The worker's one IndexedDB connection.
 *
 * Extracted when `token.ts` arrived, because two modules opening the same database each with
 * their own `onupgradeneeded` is a race with a silent outcome: whichever opens first defines
 * the schema, and the other finds a store that does not exist. One opener, one upgrade, one
 * cached connection.
 *
 * Everything here is failure-tolerant by construction. This runs inside a `fetch` handler on a
 * page the toolbar is only observing, so a thrown error is not a bug report — it is the toolbar
 * breaking a customer's request. Storage can be denied outright, be blocked by another tab
 * mid-upgrade, or throw on property access alone in a partitioned context.
 */

let db: IDBDatabase | undefined;
let opening: Promise<IDBDatabase | undefined> | undefined;
let failed = false;

/** True once opening the database has failed. Latched — a denied origin does not recover. */
export function openFailed(): boolean {
  return failed;
}

/** Test seam. Drops the cached connection so the next call reopens. */
export function resetDb(): void {
  db?.close();
  db = undefined;
  opening = undefined;
  failed = false;
}

export function openDb(): Promise<IDBDatabase | undefined> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;

  opening = new Promise<IDBDatabase | undefined>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      /* `indexedDB` can throw on access alone in a partitioned or blocked context. */
      failed = true;
      resolve(undefined);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;

      /* The request log is a cache — recreating it on a version bump costs nothing but the
         records already pruned by age anyway. */
      if (database.objectStoreNames.contains(STORE)) database.deleteObjectStore(STORE);
      const store = database.createObjectStore(STORE, { keyPath: "order" });
      /* Pruning walks by age, and the join reads in insertion order — both are served by
         one index rather than a full scan. */
      store.createIndex("at", "at");

      /* The token store is **created and never deleted**, which is the opposite of the rule
         above and deliberate. A version bump that dropped it would silently disconnect every
         user who had chosen to persist a token, and the symptom — "d0bar is asking for my
         token again" — names no cause. */
      if (!database.objectStoreNames.contains(TOKEN_STORE)) {
        database.createObjectStore(TOKEN_STORE);
      }
    };

    request.onsuccess = () => {
      db = request.result;
      /* A second tab upgrading the schema would otherwise block forever holding this
         connection open. Close and degrade rather than wedge the other tab. */
      db.onversionchange = () => {
        db?.close();
        db = undefined;
        opening = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      failed = true;
      resolve(undefined);
    };
    request.onblocked = () => {
      failed = true;
      resolve(undefined);
    };
  });

  return opening;
}
