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
first consumer**, which is why §1.3 stays unchecked below.

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

`/oauth/register`, `/oauth/token` and `/oauth/revoke` return the identical preflight. So the
data API *and* the three programmatic OAuth endpoints are all reachable from an arbitrary
customer origin with a bearer header. This was the assumption most likely to force an
architecture change, and it holds.

Two riders, both load-bearing:

- `access-control-allow-origin: *` and `credentials: 'include'` are mutually exclusive. Every
  call must be a bearer in a header and never a cookie. That is what is designed, but it is now
  a constraint rather than a preference.
- `/oauth/authorize` answers `405` to `OPTIONS` and `GET`-only. Correct — it is a top-level
  navigation into a popup, not a fetch — but it means the popup, not CORS, is the mechanism.

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

## Custody

| Holder | Holds | Readable by host page |
| --- | --- | --- |
| Page JS | an opaque session handle | yes, and useless alone |
| Service worker IndexedDB | access token, refresh token, PKCE verifier | **no** |

The page asks the worker to make a call; the worker attaches the bearer. A host page that reads
everything d0bar puts in the page realm still cannot obtain a credential.

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

Dynamic registration means registering the customer's own origin. **Unverified.** Confirming it
requires a `POST /oauth/register`, which creates a client record in Dash0's production control
plane — a write to a live external system, not a read — so it is not something to run
unannounced. See §1.3.

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
