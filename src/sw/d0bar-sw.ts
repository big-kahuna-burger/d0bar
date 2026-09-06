import { serveBroker, type BrokerScope } from "./broker";
import { observeFetches, type WorkerScope } from "./observe";

/**
 * The standalone worker.
 *
 * Built as its own artifact and served by the host at a path it chooses, same-origin. This
 * is the variant for a page with no service worker of its own; a host that already has one
 * imports `module.ts` into it instead and never loads this file.
 *
 * It still serves no responses — `respondWith` is banned here by lint and by a test that greps
 * this built artifact, and the token broker below does not touch that. The broker calls the
 * Dash0 API itself; it never intercepts a request the page made.
 *
 * The log is still read straight out of IndexedDB rather than over a message, for the reason in
 * `protocol.ts`: a message handler for the *log* would run correlation work on the host's main
 * thread during load. The broker's four messages are a user-initiated paste, a disconnect, a
 * status read and one query per panel interaction. None of them is on the load path.
 */
observeFetches(globalThis as unknown as WorkerScope);

/* The broker installs unconditionally, because the regions it may reach are compiled in and the
 * developer picks one in the connect surface. `?api` is the escape hatch for an origin that
 * table does not carry — a self-hosted or preview endpoint:
 *
 *   navigator.serviceWorker.register("/d0bar-sw.js?api=https://api.<region>.aws.dash0.com")
 *
 * It comes off this script's own URL rather than from a message because the host already chooses
 * the path this file is served from: the query string is set when the site is built, which is a
 * different trust level from the page naming an origin at runtime. See `regions.ts`. */
const extra = new URL(location.href).searchParams.get("api");
serveBroker(globalThis as unknown as BrokerScope, extra ? { apiOrigin: extra } : {});
