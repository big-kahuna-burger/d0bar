# Design — pasted token

## A service worker cannot keep a secret from its own page

`add-credential-broker` was built on this table:

| Holder | Holds | Readable by host page |
| --- | --- | --- |
| Service worker IndexedDB | access token, refresh token, PKCE verifier | **no** |

That row is false, and nothing in this repo had to be probed to find out — `src/sw/protocol.ts`
says it in its own words:

> IndexedDB is per-origin, not per-realm, so the page opens the same database the worker wrote.

Tier 2 *depends* on that. The worker writes the request log; the page reads it back; the test
`tier2.spec.ts › logs the traceparent the page cannot see` reads worker-written records from
page context and passes. A store the page reads by design is not a store the page cannot read.

The property generalises. There is no worker-private persistent storage of any kind:
IndexedDB, CacheStorage and the rest are keyed by origin, and both realms are the same origin.

Rejected repairs, so they are not re-proposed:

- **Encrypt with a non-extractable `CryptoKey` kept in IndexedDB.** The page opens the same
  database, gets the same key handle, and calls `crypto.subtle.decrypt()`. `extractable: false`
  prevents *exporting* a key, not *using* one.
- **A cross-origin iframe.** This would genuinely work — storage is partitioned by the
  iframe's origin. It also puts a third-party origin on the customer's page, which is the
  opposite of the standalone same-origin bundle this project is.
- **Downscope the token server-side.** No token-exchange endpoint exists.
- **An HttpOnly cookie.** Genuinely browser-held and unreadable by JS, and foreclosed twice
  over: `access-control-allow-origin: *` makes `credentials: 'include'` illegal, and setting one
  would require a login on Dash0's origin, which is the flow the origin allowlist blocks.

The one design that would beat a bearer token is **request signing against a non-extractable
`CryptoKey`**. The page could sign but never extract, so a credential lifted from IndexedDB
would be unusable off the device — a real improvement, and not a small one. It requires Dash0 to
accept signed requests, which it does not. That is the same class of blocker as the origin
allowlist: server-side support that does not exist. Worth raising alongside it.

## So the restriction is the boundary, not the custody

This is the part `add-credential-broker` got wrong by conflating the two credential families.
It reasoned about custody because it assumed a broad credential. An `auth_…` token can be
restricted where an OAuth token cannot:

| | required for d0bar | why |
| --- | --- | --- |
| Permissions | `Reading` | it never writes; `All` would let a leak change dashboards and alert rules |
| Dataset | the one dataset this page reports to | a leak reaches no other environment |
| Signal types | spans, logs | the two the panel reads |

A token restricted that way is roughly the sensitivity class of the ingest token Dash0 already
tells you to embed in page source. "The host page can read d0bar's read-only token for the
dataset this page is already shipping telemetry to" is a real statement and a small one. It is
not the statement the broker would have had to make, which was "the host page can read a
`*`-scoped credential for the whole organisation".

**d0bar cannot verify any of this.** There is no endpoint that reports a token's own
permissions, and the only way to discover that a token can write is to attempt a write, which
is not something a toolbar does to find out. So the UI states the requirement and states that
it is unverified. It does not imply a check it has not made.

## Custody is a choice, stated where the choice is made

```
paste ──▶ "remember on this device"  ──▶ worker IndexedDB
          host page can read it if it tries; survives reload and restart

      ──▶ "this session only"        ──▶ worker global scope
          host page cannot read it; gone when the worker is terminated
```

Session-only is real custody: a variable in the worker's global scope is in a realm the page
has no handle to. Its cost is the service worker lifecycle — the browser terminates an idle
worker, and the token goes with it. **Not measured yet**; the figure usually quoted for Chrome
is ~30s without an event, and this change does not assert it until the probe in tasks §5 has
run. Whatever it turns out to be, the UI must say the token will need re-pasting rather than
letting it look like a bug when the panel goes quiet.

Neither option is presented as the safe one. The default is session-only, because a default
that silently persists a credential is a decision made on the user's behalf.

## The worker calls the API; it does not intercept

The obvious design — the worker adds `Authorization` to d0bar's outbound calls — requires
`respondWith`. That is banned in `src/sw/**` by lint *and* by a test that greps the built
artifact, because a worker that responds is a toolbar serving the request it is measuring.

Attaching a header to d0bar's own API call would not touch anything measured, so an exemption
is arguable. It is not taken. An exemption to a structural guarantee is how the guarantee
stops holding, and there is a design that does not need one:

```
page                      worker                       Dash0
  │  postMessage {query}    │                            │
  ├────────────────────────▶│                            │
  │                         │  fetch(url, bearer)        │
  │                         ├───────────────────────────▶│
  │                         │◀───────────────────────────┤
  │  postMessage {rows}     │                            │
  │◀────────────────────────┤                            │
```

The page never issues the request, so there is no fetch event to intercept and `respondWith`
is not reached for. The worker is an RPC endpoint for d0bar's own calls, not an interceptor.
The ban is untouched by this change.

The worker's `fetch()` carries no `Origin` of the page's — a worker-initiated request to a
cross-origin URL sends `Origin: null` or the worker's own origin depending on mode, which is
worth knowing given that origin-allowlisting is what killed the OAuth path. Verified in
tasks §5 rather than assumed here.

## Why `postMessage` here, when `protocol.ts` refuses it

`protocol.ts` rejects a message protocol for the request log, and the reason is specific:

> a message handler on the page would run the toolbar's correlation work on the host's main
> thread at the moment its TBT is being measured

That is an argument about the per-request hot path during load, and it is correct there. A
token paste is one message, user-initiated, long after settle, and a query is one message per
panel interaction. Neither is on the load path. The rule is "no toolbar work on the host's main
thread during load", not "no messages" — and the log stays in IndexedDB.

## The allowlist

The worker attaches the bearer only to the configured Dash0 API origin, compared as a parsed
origin and never as a string prefix — `https://api.eu-west-1.aws.dash0.com.evil.test` passes a
`startsWith` check and fails an origin comparison. A query for any other origin is refused and
the refusal is reported, not silently dropped.

## What the page can learn

The worker answers `status` with `{ connected, source, hint }` where `hint` is the token's last
four characters, for telling two pasted tokens apart. It never returns the token, and there is
no message that does. Dash0's own `dash0.auth.token` span attribute records the last seven
digits for the same purpose, so the shape is not novel.

## Measured, not assumed

Two things this design rested on were beliefs until they were probed. Both are now numbers.

### What a worker-initiated cross-origin `fetch` carries

The question mattered because origin allowlisting is exactly what killed the OAuth path
(`add-credential-broker` §1.3), and nothing said it would not kill this one too.

Driven through the real broker — `connect` then `query` over a `MessagePort` to a registered
worker — against a loopback echo route. `localhost:8732` and `127.0.0.1:8732` are the same
process and different origins, so this is a genuine cross-origin request with no second server:

```
origin           http://127.0.0.1:8732      ← the page's origin
referer          http://127.0.0.1:8732/
sec-fetch-site   cross-site
sec-fetch-mode   cors
sec-fetch-dest   empty
cookie           absent
authorization    Bearer
```

**A worker's request is indistinguishable from the page's at the `Origin` header.** It carries
the page's origin, not `null` and not the API's. Combined with the data API answering
`access-control-allow-origin: *` to a foreign `Origin` — verified on all six regions — the
assumption holds, and the OAuth finding does not transfer.

Two things fall out of the same reading. `credentials: "omit"` works: no cookie is sent, which
is a correctness constraint rather than a preference, because a credentialed request is illegal
against `allow-origin: *`. And the bearer arrives, so the header is not being stripped.

This is now an assertion in `tests/perf/token-custody.spec.ts` rather than a one-off. It runs in
about 3 seconds and it guards the premise of the whole change.

### How long an idle worker keeps the session-only copy

`controller.state` was the first instrument and it is the wrong one: it describes the
*registration*, which stays `activated` straight across a terminated instance. What answers the
question is the session-only copy itself — it lives in the worker's global scope, so its
disappearance **is** the termination, and it is also the thing the custody mode promises.

Measured by connecting, then going completely silent for a gap, then asking once. Every message
wakes the worker and restarts its idle timer, so the gaps were taken one at a time:

```
gap      session-only token
 15s     alive
 30s     alive
 60s     alive
120s     alive
```

**A lower bound, not a lifetime.** The probe never observed a termination, so what it establishes
is that the token survives at least two minutes of idleness in Playwright's Chromium — not when
it dies. The commonly quoted "~30 seconds" did not happen here, which is enough to know the
connect surface should not promise a number.

Two caveats, because they would change the reading. Playwright drives Chromium with the DevTools
protocol attached, and a browser under automation may keep workers warm longer than one on a
user's desk. And the page stayed open throughout; a closed tab is a different question this did
not ask.

So the copy stays qualitative — "the browser shuts an idle worker down, so you will paste it
again after a quiet spell". That sentence is true at any lifetime, which is the point of not
putting a number in it. The 3.8-minute probe was deleted rather than kept in CI; the result is
here.
