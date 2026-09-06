/**
 * The page ↔ worker contract for the pasted token.
 *
 * Here rather than in `src/sw/` because both realms need it and `src/sw` is excluded from the
 * main `tsconfig` — the worker builds against `lib.webworker`, the panel against `lib.dom`, and
 * a shared file is the only thing both can import. `stage2.ts` is here for the same reason.
 *
 * **The shape is the security property.** There is no message that returns the token and no
 * field that carries it, and that is enforced by these types rather than by remembering: a
 * reply is a `TokenStatus` or a `QueryOutcome`, neither of which has anywhere to put it.
 */

export type TokenSource = "none" | "session" | "stored";

/**
 * Everything the page is allowed to know about the stored credential.
 *
 * `hint` is the last four characters, for telling two pasted tokens apart in the UI. Dash0's own
 * `dash0.auth.token` span attribute records the last seven digits for exactly this purpose, so
 * the idea is theirs; four rather than seven because this one sits next to a connect button and
 * has no other job.
 */
export interface TokenStatus {
  connected: boolean;
  source: TokenSource;
  hint: string;
  /**
   * The API origin the worker will send the token to, or `""`.
   *
   * Reported back so the panel shows where the credential is actually going rather than what it
   * asked for — if the worker refused the region, the difference is visible instead of silent.
   */
  apiOrigin: string;
}

/**
 * Why a query did not return data.
 *
 * Every failure is named. "No data" because the token was rejected and "no data" because the API
 * was unreachable are different problems with different fixes, and neither of them is an empty
 * result — which is what the panel would otherwise render for all three.
 */
export type QueryFailure = "not-connected" | "refused-origin" | "rejected" | "unreachable";

export type QueryOutcome =
  { ok: true; status: number; body: string } | { ok: false; reason: QueryFailure };

export type BrokerRequest =
  /* `region` is an **id** from `regions.ts`, never a URL. The worker resolves it against its
     own compiled table, so a page cannot name an origin of its own and have the token sent
     there. See the note at the top of `regions.ts`. */
  | { kind: "connect"; token: string; persist: boolean; region: string }
  | { kind: "disconnect" }
  | { kind: "status" }
  /**
   * One API call, made by the worker with the connected token attached.
   *
   * `method` and `body` exist because the trace endpoint is a POST: `/api/trace/details` takes
   * the trace id and a time range in a JSON body. They are optional and default to a GET with
   * no body, so every existing caller is unchanged.
   *
   * **Neither widens what the page can reach.** The destination is still `url`, still checked
   * against the origin the token was connected *for*, and a body cannot move a request to a
   * different host. What a body does add is a way for the page to send arbitrary content to
   * the API under the developer's own credential — which is exactly what the panel is for, and
   * is bounded by the origin check rather than by inspecting the body.
   */
  | { kind: "query"; url: string; method?: string; body?: string };

export type BrokerReply =
  { kind: "status"; status: TokenStatus } | { kind: "query"; outcome: QueryOutcome };

export const DISCONNECTED: TokenStatus = {
  connected: false,
  source: "none",
  hint: "",
  apiOrigin: "",
};
