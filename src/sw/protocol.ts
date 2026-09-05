/**
 * The contract between the worker and the page.
 *
 * Deliberately not a `postMessage` protocol. The worker sees a `fetch` event for every
 * request the page makes, and the load phase is exactly when those arrive in bursts — so a
 * message handler on the page would run the toolbar's correlation work on the host's main
 * thread at the moment its TBT is being measured, which is the one thing this change exists
 * to avoid. The worker writes to IndexedDB, the page reads once after settle, and nothing
 * crosses the boundary in between.
 *
 * IndexedDB is per-origin, not per-realm, so the page opens the same database the worker
 * wrote. That is also what makes the log durable across a reload for free.
 */

/** Bumped only when a store's shape changes; `onupgradeneeded` in `db.ts` applies it. */
export const DB_NAME = "d0bar";
/** 2 added `TOKEN_STORE`. The request log is recreated on a bump; the token store never is. */
export const DB_VERSION = 2;
export const STORE = "requests";

/**
 * Where a persisted auth token lives.
 *
 * Same database as the log rather than its own, so there is one connection and one upgrade
 * path — see `db.ts`. Note what this store is *not*: it is not private to the worker. The page
 * opens this database too, by design, which is the whole reason `token.ts` offers a
 * session-only mode and says out loud what the persisted mode costs.
 */
export const TOKEN_STORE = "auth";

/** Oldest records are pruned past either bound, whichever binds first. */
export const MAX_RECORDS = 2000;
export const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * One observed request, as the worker stores it.
 *
 * The URL is a string here, not an interned `u32`: interning is per-realm, and the worker's
 * table would mean nothing to the page's. The page interns on read, which is where the ids
 * have to agree anyway — the join keys on the page's table.
 */
export interface FetchRecord {
  /** Monotonic within a worker generation. The join pops per-URL FIFOs in this order. */
  order: number;
  url: string;
  method: string;
  /** `Date.now()` at observation, for age-based pruning and reload correlation. */
  at: number;
  /** 32 lowercase hex characters, or `""` when the request carried no usable traceparent. */
  traceId: string;
  /** The parent span id, 16 hex characters, or `""`. */
  spanId: string;
  /** The `sampled` bit of the traceparent flags. Meaningless when `traceId` is empty. */
  sampled: boolean;
  /** `event.request.destination`, which is the worker's nearest analogue to initiatorType. */
  destination: string;
}

/**
 * Parses a W3C `traceparent`.
 *
 * Returns `undefined` for anything that is not a well-formed, non-zero header rather than
 * guessing at a repair. A malformed traceparent is a header the toolbar cannot vouch for,
 * and a trace id invented from a broken one would be presented to the user with exactly the
 * same confidence as a real one — which is the failure this whole change is built to avoid.
 *
 * Version `00` is the only version defined. The spec requires that future versions still
 * parse as `version-traceid-spanid-flags`, so a higher version with a well-formed body is
 * accepted rather than rejected; `ff` is explicitly forbidden.
 */
export function parseTraceparent(
  value: string | null,
): { traceId: string; spanId: string; sampled: boolean } | undefined {
  if (!value) return undefined;
  const parts = value.trim().split("-");
  if (parts.length < 4) return undefined;

  const [version, traceId, spanId, flags] = parts as [string, string, string, string];

  if (!isHex(version, 2) || version === "ff") return undefined;
  if (!isHex(traceId, 32) || traceId === "00000000000000000000000000000000") return undefined;
  if (!isHex(spanId, 16) || spanId === "0000000000000000") return undefined;
  if (!isHex(flags, 2)) return undefined;

  /* Version 00 defines exactly four fields. Later versions may append, but must not have
     fewer — a five-field `00` header is malformed, not forward-compatible. */
  if (version === "00" && parts.length !== 4) return undefined;

  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    sampled: (parseInt(flags, 16) & 0x01) === 1,
  };
}

function isHex(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (let i = 0; i < length; i += 1) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    const upper = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}
