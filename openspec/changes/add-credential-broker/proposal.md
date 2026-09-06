# add-credential-broker

## Why
A standalone same-origin bundle has one real weakness: it has no storage the host page cannot
read. The service worker answers it. Tokens live in the worker's own IndexedDB and the worker
attaches the bearer to d0bar's API calls, so **the page's JavaScript never holds the token**. *(Withdrawn — the page can read the worker's
IndexedDB. See design.md.)*

The concurrency is the other half. Several 401s must trigger exactly one refresh — an invoked
actor with event queueing handles it in-tab, and `navigator.locks` handles it across tabs.

## What Changes
- `authMachine`: discovery → dynamic registration → PKCE popup → exchange → refresh.
- Token custody in the service worker; the page holds only an opaque session handle.
- One refresh across all tabs via Web Locks; result published over `BroadcastChannel`.
- Scopes read from `scopes_supported`, never hardcoded — though the server advertises exactly
  `["*"]` today, so this narrows nothing and the token is full-privilege. See design.md.

## Impact
- New capability: `credential-broker`
- New: `src/auth/`, `src/sw/broker.ts`
- Depends on: `add-sw-correlator` (the worker), `add-trace-view` (the caller)
- **Verified, and it changes the change.** The authorization server is real — RFC 8414 discovery,
  dynamic registration, PKCE S256, public client. The data API is reachable from a customer
  origin with a bearer. But `/oauth/register` and `/oauth/token` are **origin-allowlisted**: a
  `POST` carrying `Origin: https://shop.example.com` returns `403` with an empty body, on dev and
  on production, while the same request with no `Origin` succeeds. Production permits only
  `https://app.dash0.com`; `http://localhost` is refused there too.
  The CORS preflight advertises `access-control-allow-origin: *` and does not reflect this.
- **So the browser OAuth flow cannot run from a customer origin, which is d0bar's whole
  deployment target.** §1.4 fires: §2, §4 and §5 are held rather than built. See design.md.
- **§3 does not survive either.** The claim that it did was made in the same breath and was
  wrong: a service worker cannot keep a secret from its own page, IndexedDB being per-origin.
  `add-pasted-token` carries the corrected design.
- **Revised by the measurement**: `scopes_supported` is `["*"]` — the scope narrowing this change
  specified cannot be built, and the credential in custody is full-privilege rather than
  read-scoped. There is also no region-independent issuer, which the design did not account for.
