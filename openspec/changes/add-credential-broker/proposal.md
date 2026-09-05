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
- Scopes taken from `scopes_supported`, never hardcoded.

## Impact
- New capability: `credential-broker`
- New: `src/auth/`, `src/sw/broker.ts`
- Depends on: `add-sw-correlator` (the worker), `add-trace-view` (the caller)
- **Blocked on verification**: a CORS preflight against a regional endpoint from an unrelated
  origin. This is the one assumption that could force an architecture change — see tasks §1
