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
 */
const tag = typeof document !== "undefined" ? document.currentScript : null;
if (tag instanceof HTMLScriptElement && tag.dataset.d0barEnabled !== undefined) {
  init({ enabled: true });
}
