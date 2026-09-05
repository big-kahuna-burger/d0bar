import { addRegion } from "../shared/regions";
import { handle, replierFor } from "./messages";

/**
 * Installs the token broker's message listener.
 *
 * Separate from `observeFetches` and separately invoked, because the two do unrelated jobs and
 * a host may want one without the other: observation needs no credential, and a host who never
 * connects a token should not have a message listener they did not ask for. Nothing here runs
 * unless it is called.
 *
 * The region is chosen by the developer in the connect surface and resolved inside the worker
 * from the compiled table in `regions.ts`. There is deliberately no default origin: there is no
 * `api.dash0.com`, Dash0's issuers being regional, so any default would be a guess at which
 * region a customer is in and wrong for everyone else in a way that surfaces much later as an
 * authorization failure.
 */

/**
 * The slice of the worker scope this file uses. Structural, like `WorkerScope` in `observe.ts`,
 * and for the same two reasons: it states the real surface, and it typechecks under `lib.dom`
 * so the handler is unit-testable without a registration.
 */
export interface BrokerScope {
  addEventListener(
    type: "message",
    listener: (event: {
      readonly data: unknown;
      readonly ports?: readonly MessagePort[];
      readonly source?: { postMessage(message: unknown): void } | null;
      waitUntil?(promise: Promise<unknown>): void;
    }) => void,
  ): void;
}

export interface BrokerOptions {
  /**
   * An API origin outside the compiled region table, e.g. a self-hosted or preview endpoint.
   *
   * Optional. Without it the worker serves the regions in `regions.ts` and nothing else, which
   * is the normal case.
   */
  apiOrigin?: string;
}

export function serveBroker(scope: BrokerScope, options: BrokerOptions = {}): void {
  /* An override, not a requirement. The region is normally chosen in the connect surface and
     resolved from the compiled table in `regions.ts`; this is the host-controlled escape hatch
     for a region that table does not carry, and it is allowed to be an arbitrary origin
     precisely because the host sets it when the site is built rather than the page setting it
     at runtime. */
  const override = options.apiOrigin ? normalize(options.apiOrigin) : "";
  if (options.apiOrigin && override === "") return;
  if (override !== "") registerOverride(override);

  scope.addEventListener("message", (event) => {
    const reply = replierFor(event);
    if (!reply) return;
    const work = handle(event.data, reply);
    /* Keeps the worker alive until the reply is posted. Without it a worker woken only by this
       message can be terminated between the `await` and the `postMessage`, and the panel waits
       forever on a promise nothing will settle. */
    event.waitUntil?.(work);
  });
}

/** Returns the origin, or `""` for anything that is not a usable absolute https origin. */
function normalize(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.origin === "null") return "";
  /* `http:` is permitted only for loopback, which is where a developer proxies the API. Any
     other plaintext origin would put the token on the wire in clear. */
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return parsed.origin;
  return "";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Registers a host-supplied origin as an additional allowed destination.
 *
 * Kept here rather than in `regions.ts` so that the compiled table stays a constant: the table
 * is what the *page* may choose from, and this is what the *host* added. Two different trust
 * levels, two different mechanisms.
 */
function registerOverride(origin: string): void {
  addRegion({ id: origin, env: "prod", label: origin, origin });
}
