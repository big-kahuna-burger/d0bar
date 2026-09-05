# add-credential-broker

## Why
A standalone same-origin bundle has one real weakness: it has no storage the host page cannot
read. The service worker answers it. Tokens live in the worker's own IndexedDB and the worker
attaches the bearer to d0bar's API calls, so **the page's JavaScript never holds the token**.

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
- **Verified**: the CORS preflight passes — `access-control-allow-origin: *` with `Authorization`
  allowed, on the data API and on `/oauth/{register,token,revoke}`. The authorization server is
  real: RFC 8414 discovery, dynamic registration, PKCE S256, public client. See design.md.
- **Still blocked**: dynamic registration of arbitrary origins (§1.3) needs a `POST` that creates
  a client record in Dash0 production, so it has not been run.
- **Revised by the measurement**: `scopes_supported` is `["*"]` — the scope narrowing this change
  specified cannot be built, and the credential in custody is full-privilege rather than
  read-scoped. There is also no region-independent issuer, which the design did not account for.
