import { init, destroy } from "./collector";
import type { D0barConfig, D0barHandle, Diagnostics } from "./collector";

export { init, destroy };
export type { D0barConfig, D0barHandle, Diagnostics };

/**
 * IIFE auto-start.
 *
 * `document.currentScript` is a live element only while a classic script is executing, and
 * is null during ES module evaluation. So this check is inert for the ESM build by
 * construction — importing the package still does nothing until `init()` is called — while
 * the `<script>` build can be configured from its own tag:
 *
 *   <script src="d0bar.iife.js" data-d0bar-enabled></script>
 *
 * The keyboard shortcut is the toolbar's only listener on the host page, so the script tag
 * can decline it without declining the toolbar:
 *
 *   <script src="d0bar.iife.js" data-d0bar-enabled data-d0bar-shortcut="off"></script>
 *   <script src="d0bar.iife.js" data-d0bar-enabled data-d0bar-shortcut="Ctrl+Alt+D"></script>
 *
 * Tier 2 is opted into the same way, by naming the path the host serves the worker from:
 *
 *   <script src="d0bar.iife.js" data-d0bar-enabled data-d0bar-sw="/d0bar-sw.js"></script>
 *
 * Absent, tier 2 stays off and the panel says so. There is no default path: registering a
 * service worker is a persistent, origin-scoped side effect on someone else's site, and a
 * path d0bar invented would 404 against their routing.
 */
const tag = typeof document !== "undefined" ? document.currentScript : null;
if (tag instanceof HTMLScriptElement && tag.dataset.d0barEnabled !== undefined) {
  const spec = tag.dataset.d0barShortcut;
  const swPath = tag.dataset.d0barSw;
  init({
    enabled: true,
    ...(swPath ? { sw: { path: swPath } } : {}),
    /* Absent leaves the default chord in place; `off`, `false` or `none` opts out of the
       listener entirely; anything else is a chord. */
    shortcut:
      spec === undefined
        ? undefined
        : spec === "off" || spec === "false" || spec === "none"
          ? false
          : spec,
  });
}
