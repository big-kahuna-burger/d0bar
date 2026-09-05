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

/* The API origin comes off this script's own URL:
 *
 *   navigator.serviceWorker.register("/d0bar-sw.js?api=https://api.eu-west-1.aws.dash0.com")
 *
 * The host already chooses the path this file is served from, so the query string costs them
 * nothing extra. With no `api` parameter the broker does not install and d0bar has no token
 * path at all — which is the correct outcome, not a degraded one: there is no `api.dash0.com`
 * to fall back to, Dash0's issuers being regional. */
serveBroker(globalThis as unknown as BrokerScope, {
  apiOrigin: new URL(location.href).searchParams.get("api") ?? "",
});
