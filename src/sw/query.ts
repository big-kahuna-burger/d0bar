import type { QueryOutcome } from "../shared/broker";
import { apiOrigin, bearer } from "./token";

/**
 * d0bar's own API calls, made by the worker.
 *
 * **Why the worker calls rather than intercepts.** The obvious design is to let the page fetch
 * and have the worker add `Authorization` on the way past. That needs `respondWith`, which is
 * banned in `src/sw/**` by lint *and* by a test that greps the built artifact, because a worker
 * that responds is a toolbar serving the request it is measuring. Attaching a header to d0bar's
 * own call would not touch anything measured, so an exemption is arguable — and it is not taken,
 * because an exemption to a structural guarantee is how the guarantee stops holding. The page
 * never issues these requests at all, so there is no fetch event and nothing to exempt.
 *
 * The token reaches exactly one place: the `Authorization` header of a request whose origin
 * equals the configured API origin. It is never part of a reply, an error, or a log line.
 */

/**
 * Performs one API call.
 *
 * The allowed origin is the one the connected token was connected *for*, resolved from a
 * compiled table by id — see `regions.ts`. Nothing the page sends can widen it.
 */
export async function query(url: string): Promise<QueryOutcome> {
  /* The origin comes from the connected credential, not from the caller. An `apiOrigin`
     parameter was the first shape and it put the allowlist in the hands of whoever called —
     which, one hop back, is the page. */
  if (!allowed(url, apiOrigin())) return { ok: false, reason: "refused-origin" };

  const token = bearer();
  /* Checked after the origin, so a query for the wrong origin is refused as a wrong origin
     whether or not anyone is connected — the more specific answer, and the one that does not
     depend on state the caller cannot see. */
  if (token === "") return { ok: false, reason: "not-connected" };

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      /* Never `include`. The API answers `access-control-allow-origin: *`, and a wildcard and
         credentialed request are mutually exclusive — the browser rejects the response
         outright. The bearer is the only credential here by construction. */
      credentials: "omit",
      mode: "cors",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  /* A rejected token is its own outcome. It is the one failure the user can act on, and
     folding it into a generic error would leave them looking at the network. */
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected" };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  return { ok: true, status: response.status, body };
}

/**
 * Whether a URL may carry the token.
 *
 * Parsed origins, never a string prefix. `https://api.eu-west-1.aws.dash0.com.evil.test`
 * satisfies `startsWith("https://api.eu-west-1.aws.dash0.com")` and would have been handed the
 * credential; it is a different origin and fails here. The same for a userinfo prefix
 * (`https://api.eu-west-1.aws.dash0.com@evil.test`), which `URL` resolves to `evil.test`.
 *
 * Exported for the test that spells those cases out.
 */
export function allowed(url: string, apiOrigin: string): boolean {
  let target: URL;
  let expected: URL;
  try {
    target = new URL(url);
    expected = new URL(apiOrigin);
  } catch {
    return false;
  }
  /* An opaque origin serialises as the string "null", and two of them would compare equal.
     Nothing with an opaque origin is the configured API. */
  if (target.origin === "null" || expected.origin === "null") return false;
  return target.origin === expected.origin;
}
