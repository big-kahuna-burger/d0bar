import { observeFetches, type WorkerScope } from "./observe";

/**
 * The importable variant, for hosts that already own their scope.
 *
 * One worker controls a scope, and it is the host's — d0bar does not get to take it, and
 * will not unregister anyone's worker to make room. So the third path is that the host
 * imports this into the worker they already have:
 *
 *   // a classic worker
 *   importScripts("/d0bar-sw-module.js");
 *   D0barSW.observe();
 *
 *   // a module worker
 *   import { observe } from "/d0bar-sw-module.js";
 *   observe();
 *
 * Installation is an explicit call in both forms. An earlier draft sniffed the module
 * context and self-installed, which is both unreliable — `import.meta` is a syntax error in
 * the classic build — and the wrong default: adding listeners to someone else's worker as a
 * side effect of loading a file is exactly the kind of thing this toolbar refuses to do to a
 * host page.
 *
 * The listeners are additive. `fetch` handlers compose, and because d0bar's never calls
 * `respondWith`, the host's handler decides the response exactly as it did before. That is a
 * property of the ban rather than of registration order — two handlers both trying to
 * respond would race, and only one of them is permitted to try.
 */

/** Installs d0bar's observation listeners on the calling worker's scope. */
export function observe(scope?: WorkerScope): void {
  observeFetches(scope ?? (globalThis as unknown as WorkerScope));
}
