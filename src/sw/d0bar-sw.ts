import { observeFetches, type WorkerScope } from "./observe";

/**
 * The standalone worker.
 *
 * Built as its own artifact and served by the host at a path it chooses, same-origin. This
 * is the variant for a page with no service worker of its own; a host that already has one
 * imports `module.ts` into it instead and never loads this file.
 *
 * Nothing but observation happens here. The worker holds no credentials, serves no
 * responses, and has no message API — the page reads its log straight out of IndexedDB.
 */
observeFetches(globalThis as unknown as WorkerScope);
