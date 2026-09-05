import { handle, replierFor } from "./messages";

/**
 * Installs the token broker's message listener.
 *
 * Separate from `observeFetches` and separately invoked, because the two do unrelated jobs and
 * a host may want one without the other: observation needs no credential, and a host who never
 * connects a token should not have a message listener they did not ask for. Nothing here runs
 * unless it is called.
 *
 * `apiOrigin` is required rather than defaulted. There is no `api.dash0.com` — Dash0's issuers
 * are regional and the issuer *is* the region — so any default would be a guess at which
 * region a customer is in, wrong for everyone else, and wrong in a way that surfaces much later
 * as an authorization failure. A missing origin means no broker at all.
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
  /** The organization's regional Dash0 API origin, e.g. `https://api.eu-west-1.aws.dash0.com`. */
  apiOrigin: string;
}

export function serveBroker(scope: BrokerScope, options: BrokerOptions): void {
  const apiOrigin = normalize(options.apiOrigin);
  /* Refusing to install beats installing something that answers every query with a refusal:
     the second looks like a broker that is working and finding nothing. */
  if (apiOrigin === "") return;

  scope.addEventListener("message", (event) => {
    const reply = replierFor(event);
    if (!reply) return;
    const work = handle(event.data, reply, apiOrigin);
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
