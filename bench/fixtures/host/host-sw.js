/**
 * A service worker belonging to the *host page*, which knows nothing about d0bar.
 *
 * The instrument for outcome 3 in `src/collector/sw.ts`: an origin whose scope is already
 * owned by someone else's worker, which has not imported d0bar's module and is under no
 * obligation to. d0bar must refuse to register, report `scope-owned`, and render the whole
 * degraded path — that is a supported state, not a failure to route around.
 *
 * Deliberately as ordinary as a real host's worker: it claims the page as fast as it can, so
 * the fixture reaches the contended state on the first load rather than the second, and it does
 * nothing else. It has no `fetch` handler at all, which is stronger than having one that does
 * not respond — there is nothing here for d0bar to mistake for its own observation.
 */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
