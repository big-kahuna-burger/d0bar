# Design — credential broker

## What a Dash0 token can actually do

This section is measured, not assumed. Every value below was read off the live service on
2026-09-05; the probes are reproducible with `curl` and are quoted where they matter. The
design that follows was **written before any of it was checked**, and three of its claims did
not survive.

There are two unrelated credential families, and the earlier draft conflated them.

| | `auth_…` token | OAuth access token |
| --- | --- | --- |
| Created by | an org **Admin**, by hand, in Settings → Auth Tokens | the OAuth flow below, by any user |
| Form | opaque static string, `auth_abc123…` | bearer, with a refresh token |
| Expiry | none — lives until revoked | short, refreshable |
| Restrictable | dataset, signal type, and permission (`Ingesting` / `Reading` / `All`) | **no** — see *Scopes* |
| Sent as | `Authorization: Bearer …`, or Basic with the token as the password | `Authorization: Bearer …` |

The `Reading` permission on an `auth_…` token is real, so the rejected option "reusing the SDK's
`authToken` — ingest-only, unusable for reads" was imprecise. The *deployed web-SDK* token is
ingest-only, deliberately and correctly: it ships in page source where anyone can read it, and
Dash0's own guidance is to restrict a publicly distributed token to `Ingesting`. But nothing
stops an *admin* from minting a separate `Reading` token, which is a third architecture this
change never considered. It is recorded under *Alternatives* rather than buried.

### The authorization server exists, and is RFC 8414 — not OpenID Connect

```
GET https://api.eu-west-1.aws.dash0.com/.well-known/oauth-authorization-server   → 200
GET https://api.eu-west-1.aws.dash0.com/.well-known/openid-configuration          → 401
```

Discovery is at the **OAuth** well-known path. The OIDC path is not merely absent, it answers
`401`, which is the shape most likely to be misread as "needs a token" and retried forever.

```json
{
  "issuer":                              "https://api.eu-west-1.aws.dash0.com",
  "authorization_endpoint":              ".../oauth/authorize",
  "token_endpoint":                      ".../oauth/token",
  "registration_endpoint":               ".../oauth/register",
  "revocation_endpoint":                 ".../oauth/revoke",
  "userinfo_endpoint":                   ".../oauth/userinfo",
  "grant_types_supported":               ["authorization_code", "refresh_token"],
  "response_types_supported":            ["code"],
  "code_challenge_methods_supported":    ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported":                    ["*"]
}
```

`token_endpoint_auth_methods_supported: ["none"]` is a public client with no secret, and
`S256` is the only challenge method — which is exactly the shape this change assumed and the
only one a browser can implement safely. Both are confirmed.

A `.well-known/oauth-protected-resource` document (RFC 9728) is served too, naming the same
issuer. DCR + PKCE + `none` + protected-resource metadata is the MCP authorization profile;
this server was in all likelihood stood up for Dash0's MCP integration. That is not an
objection, but it does mean **its behaviour toward a browser origin is untested by its own
first consumer** — and that turned out to be the whole story. See §1.3.

### The scope narrowing in this design cannot be built

```
"scopes_supported": ["*"]
```

One scope. There is no read-only scope, no spans-and-logs scope, nothing to narrow to. An
OAuth token issued by this server carries **everything the authorizing user can do** — reading
every dataset's telemetry, and, on the evidence of the permission model, configuration as well.

This falsifies the proposal's "Scopes taken from `scopes_supported`, never hardcoded" as a
*safety* claim. Reading them from discovery is still right, and still what gets built — it is
how the toolbar notices the day Dash0 adds real scopes — but it buys nothing today, and saying
it narrows anything would be a security property claimed and not held.

The consequence runs the other way from what the proposal implies. Worker custody is not a
nice-to-have hardening of a modest read credential; it is the only thing standing between a
customer's production page and a full-privilege credential for their observability account. It
raises the stakes of this change rather than lowering them.

### CORS permits the whole flow from any origin — §1.1 and §1.2, verified

Read this section together with §1.3 below, which is the other half of it. The preflight permits
everything; the request behind it does not. Neither half is the answer on its own.

Deployed values, not `config.go` defaults, read from `api.eu-west-1.aws.dash0.com`:

```
OPTIONS /api/spans      Origin: https://shop.example.com  →  204
  access-control-allow-origin:  *
  access-control-allow-headers: Origin,Content-Length,Content-Type,Accept,Authorization,Traceparent
  access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS
  access-control-max-age:       86400

GET /api/spans?limit=1  Origin: https://shop.example.com  →  401
  access-control-allow-origin:  *
  {"error":{"code":401,"message":"unauthorized. no Authorization header in HTTP request"}}
```

`/oauth/register`, `/oauth/token` and `/oauth/revoke` return the identical preflight.

For the **data API** this is the whole answer, and it holds: `GET /api/spans` from
`https://shop.example.com` reaches the application and answers `401` for want of a bearer, with
CORS headers on the response. A customer-origin page with a token can read telemetry.

For the **OAuth endpoints** the preflight is not the answer, and reading it as one is the
mistake this document made for the first hour of checking. See §1.3.

Two riders, both load-bearing:

- `access-control-allow-origin: *` and `credentials: 'include'` are mutually exclusive. Every
  call must be a bearer in a header and never a cookie. That is what is designed, but it is now
  a constraint rather than a preference.
- `/oauth/authorize` answers `405` to `OPTIONS` and `GET`-only. Correct — it is a top-level
  navigation into a popup, not a fetch — but it means the popup, not CORS, is the mechanism.

### The OAuth endpoints are origin-allowlisted, and the preflight does not say so — §1.3

This is the one that fires §1.4. The preflight advertises `access-control-allow-origin: *`; the
**actual** request is then rejected on `Origin` by something behind it. A browser sails through
the preflight and fails the real POST with an opaque `403`, no CORS headers and an empty body —
which reaches page JavaScript as an indistinguishable network error.

`POST /oauth/token` with a deliberately invalid grant, varying only the `Origin` header. `400`
means the request reached validation, i.e. the origin was permitted; `403` means it was stopped
before that.

| `Origin` | production | dev |
| --- | --- | --- |
| *(absent — a non-browser client)* | `400` | `400` |
| `https://app.dash0.com` / `https://app.dash0-dev.com` | `400` | `400` |
| `http://localhost:8732` | **`403`** | `400` |
| `http://127.0.0.1:8732` | **`403`** | — |
| `https://shop.example.com` | **`403`** | **`403`** |

`POST /oauth/register` behaves identically. Registration itself is open — with no `Origin` header
it returned `201` and a `client_id` for redirect URIs on both `http://localhost:8732` and
`https://shop.example.com`, so the *server* has no objection to arbitrary redirect origins. The
registration is saved at `dev-client.json`. Only the browser is refused.

**So the browser OAuth flow is reachable from exactly one origin in production: Dash0's own
app.** Not from a customer's site, which is d0bar's entire deployment target, and not from
`localhost`, which would at least have supported local development. Dev additionally allows
`localhost`, so anything built and tested only against dev would appear to work and fail in
production.

This is decisive against the architecture in this document. The worker cannot register a client,
cannot exchange an authorization code, and cannot refresh, because all three are `POST`s from a
customer origin. No amount of custody design changes it — custody is about where the token
lives, and there is no token to hold.

Three ways forward, none of them "build it as designed":

1. **The pasted `auth_…` token** under *Alternatives* becomes the only architecture that works
   today from a customer origin. `GET /api/spans` with a bearer already returns a CORS-permitted
   `401` from `https://shop.example.com`, so the data plane is open even though the auth plane
   is not.
2. **Ask Dash0 to allowlist customer origins** on `/oauth/{register,token,revoke}`. This is a
   product decision about whether a browser on an arbitrary origin may hold a full-privilege
   credential, and given `scopes_supported: ["*"]` the honest answer may well be no.
3. **Move the exchange out of the browser**, which means a d0bar backend — and a standalone
   same-origin bundle with no backend is the premise of the whole project.

Note what the preflight cost here. `access-control-allow-origin: *` on these endpoints is
misleading: it advertises access that the next layer refuses. Whatever is decided, that
disagreement is worth reporting to whoever owns the control plane.

### There is no region-independent issuer

`api.dash0.com` does not resolve. Issuers are per region and the issuer *is* the region:

```
https://api.eu-west-1.aws.dash0.com   → issuer https://api.eu-west-1.aws.dash0.com
https://api.us-west-2.aws.dash0.com   → issuer https://api.us-west-2.aws.dash0.com
```

Nothing in the original design mentions this, and it is not a detail: the broker cannot
bootstrap from a fixed URL. The region has to arrive from somewhere — configuration on the
`D0bar` init call is the obvious candidate, since the host is already configuring an endpoint
for the Web SDK.

The trap: `https://www.dash0.com/.well-known/oauth-authorization-server` answers `200` with a
valid document whose issuer is hard-wired to **eu-west-1**. A US organisation that bootstraps
from the apex domain gets a working discovery document for the wrong region, and the failure
surfaces much later as an authorization error. Do not use it.

## Custody — **the table below is withdrawn**

| Holder | Holds | ~~Readable by host page~~ |
| --- | --- | --- |
| Page JS | an opaque session handle | yes, and useless alone |
| Service worker IndexedDB | access token, refresh token, PKCE verifier | ~~**no**~~ — **false** |

Kept rather than deleted, because it was believed and acted on and the correction is the useful
part. **A service worker cannot keep a secret from its own page.** IndexedDB is keyed by origin,
not by realm; the page opens the same database the worker wrote. `src/sw/protocol.ts` says so in
its own words, and tier 2 *depends* on it — the worker writes the request log and the page reads
it back. No probe was needed to find this out; it was already written down in this repo.

The property generalises to every same-origin store, so there is no repair that keeps the table
true. The only holder the page genuinely cannot reach is the worker's global scope, which does
not survive the worker being terminated.

What follows from it: the sentence below this table — "a host page that reads everything d0bar
puts in the page realm still cannot obtain a credential" — was wrong for the persisted case, and
the claim that §3 survived the §1.3 finding intact was wrong with it. `add-pasted-token` carries
the corrected design: custody is a choice the user makes with the cost stated, and the token's
own restrictions are the security boundary rather than where it is stored.

When the worker is unavailable, there is no safe degradation for token custody. The correct
behaviour is to refuse to authenticate and say why — not to fall back to `localStorage`, which
would silently hand the token to the host page. Given `scopes_supported: ["*"]`, that fallback
would hand over a full-privilege credential, so the refusal is not a conservative choice.

## One refresh, many tabs

Two layers, both required:

- **In-tab**: refresh is an invoked actor. Concurrent 401s are queued as events and the machine
  is already in `refreshing`, so only one request is issued.
- **Cross-tab**: `navigator.locks.request()` around the refresh. The lock holder refreshes and
  publishes the result on a `BroadcastChannel`; other tabs adopt it without issuing their own.

Signing in once therefore authenticates every open tab.

## Scopes

Read from the discovery document's `scopes_supported` and sent as advertised. **Not** narrowed,
because there is nothing to narrow — see the measurement above. The code reads the list rather
than hardcoding `*` so that the day Dash0 ships real scopes the toolbar requests them instead of
asking for everything, and so that a server advertising something unexpected is visible rather
than silently ignored.

The UI SHALL say what is being granted. A consent screen that reads "d0bar wants access" when
the grant is unrestricted is the kind of quiet inaccuracy this project does not ship.

## Redirect URI

Dynamic registration accepts arbitrary https origins and `http://localhost:<port>` — verified by
registering both against dev. Two riders:

- There is no wildcard. `http://localhost:*` is not a registerable value; every redirect URI is
  exact, so every developer port needs its own registration.
- It is moot for the browser path. Registration is refused from a customer origin, so the client
  that can be registered is one no browser on that origin can use. See §1.3 above.

## Alternatives

- **A pasted `Reading` auth token, no OAuth at all.** An admin mints a read-only, dataset-scoped
  `auth_…` token; the developer pastes it once; the worker holds it. Deletes the entire
  `authMachine`, the popup, the refresh actor, the lock and the `BroadcastChannel` — five of the
  six task groups. It is *more* narrowly scoped than OAuth can currently be, since `auth_…`
  tokens restrict by dataset, signal type and permission and OAuth tokens restrict by nothing.
  Against it: static and non-expiring, so a leak is permanent until an admin revokes it; needs
  an admin for every developer; and there is no sign-out beyond deleting the stored copy.

## Rejected

- **Tokens in `localStorage` or a page-realm variable** — readable by the host page, which is
  the exact weakness this change exists to close.
- **Refresh without a lock** — a refresh-token rotation race logs the user out of every tab.
- **Cookie-based auth** — foreclosed, not merely undesirable: `access-control-allow-origin: *`
  makes `credentials: 'include'` illegal.
