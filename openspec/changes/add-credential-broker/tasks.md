# Tasks — credential broker

## 1. Verify the assumption first
- [ ] 1.1 `curl -X OPTIONS` a regional API endpoint with an unrelated `Origin`; record the response headers
- [ ] 1.2 Confirm the deployed CORS value, not just the default in `config.go`
- [ ] 1.3 Confirm the control-plane API accepts dynamic registration of arbitrary https origins and `http://localhost:*`
- [ ] 1.4 If any of the above fails, stop and revise the architecture — do not build on it

## 2. authMachine
- [ ] 2.1 `src/auth/authMachine.ts` — `unauthenticated`, `discovering`, `registering`, `awaitingPopup`, `exchanging`, `authenticated`, `refreshing`
- [ ] 2.2 Discovery document fetch and validation
- [ ] 2.3 Dynamic client registration; registration result cached in the worker
- [ ] 2.4 PKCE S256: verifier generation via `crypto.getRandomValues`, challenge via `crypto.subtle`
- [ ] 2.5 `state` generated and verified; mismatch returns to `unauthenticated`
- [ ] 2.6 Popup closed without completing → `unauthenticated`, no partial state retained
- [ ] 2.7 Scopes derived from `scopes_supported`, narrowed to the minimum for reading spans and logs
- [ ] 2.8 Machine tests, no browser: popup closed, state mismatch, concurrent 401s, refresh rejected, PKCE failure
- [ ] 2.9 Unit tests for PKCE derivation against published test vectors

## 3. Worker custody
- [ ] 3.1 `src/sw/broker.ts` — token store in the worker's IndexedDB; never exposed over `postMessage`
- [ ] 3.2 Page receives an opaque session handle only
- [ ] 3.3 Worker attaches the bearer to d0bar's own API calls, matched against an allowlist of d0bar endpoints
- [ ] 3.4 Test asserting the token never appears in any page-realm value, any `postMessage` payload, or any log line
- [ ] 3.5 Worker unavailable → authentication refuses with an explanation; **no** page-realm storage fallback
- [ ] 3.6 Sign-out clears the worker store and broadcasts to every tab

## 4. Refresh concurrency
- [ ] 4.1 Refresh as an invoked actor; concurrent 401s queue rather than issuing parallel refreshes
- [ ] 4.2 `navigator.locks.request()` around refresh, so one tab refreshes for all
- [ ] 4.3 Result published on `BroadcastChannel`; other tabs adopt without their own request
- [ ] 4.4 Refresh rejected → `unauthenticated` in every tab
- [ ] 4.5 Test: three tabs, simultaneous 401s, assert exactly one refresh request
- [ ] 4.6 Proactive refresh near expiry, jittered to avoid a thundering herd across tabs

## 5. UI
- [ ] 5.1 Connect affordance in the panel; authenticated state shown in the header
- [ ] 5.2 Trace jump disabled with an explanation while unauthenticated — never a silent failure
- [ ] 5.3 Consent auto-submits for already-granted scopes, so returning developers get one click
