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
      /**
       * An out-of-line generated key, **not** `keyPath: "order"`.
       *
       * `order` is a module-level counter in the worker, and a service worker is terminated when
       * it goes idle and restarted on the next fetch event — so `order` resets to 0 for every
       * worker generation. As a key path that made the second generation's records overwrite the
       * first's at keys 0, 1, 2…: a page whose requests arrive in bursts more than ~30 s apart
       * silently lost its earlier ones, and the log stopped being the complete record the panel
       * presents it as.
       *
       * The key generator is persisted with the store, so it survives worker restarts, which is
       * exactly the property the counter cannot have without a read per request in the hot path.
       */
      const store = database.createObjectStore(STORE, { autoIncrement: true });
      /* Pruning walks by age; the generated key already gives insertion order, so this index
         serves the age pass rather than a full scan. */
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
