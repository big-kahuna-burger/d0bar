# Tasks — credential broker

## 1. Verify the assumption first
- [x] 1.1 `OPTIONS https://api.eu-west-1.aws.dash0.com/api/spans`, `Origin: https://shop.example.com`
      → `204`, `access-control-allow-origin: *`, `Authorization` in `access-control-allow-headers`,
      `access-control-max-age: 86400`. An unauthenticated `GET` from the same origin returns a
      CORS-permitted `401`. Same preflight on `/oauth/register`, `/oauth/token`, `/oauth/revoke`.
      Full headers in design.md.
- [x] 1.2 These are the deployed values, read off the live regional endpoint — no source was
      consulted. Two riders that follow from `*` and are now constraints rather than choices:
      `credentials: 'include'` is illegal, so the bearer must always be a header; and
      `/oauth/authorize` is `GET`-only (`405` to `OPTIONS`), so the popup is the mechanism there,
      not CORS.
- [x] 1.3 Registered against **dev**, on the user's instruction. The server accepts arbitrary
      redirect origins: `201` with a `client_id` for both `http://localhost:8732/...` and
      `https://shop.example.com/...`. Saved at `dev-client.json`; the `registration_access_token`
      it returned is a credential and is in the gitignored `.dash0-dev-client.local.json`.
      **But it only succeeds with no `Origin` header.** The identical POST carrying
      `Origin: https://shop.example.com` returns `403`, empty body, no CORS headers — on both
      `/oauth/register` and `/oauth/token`, on dev and on production. Production additionally
      refuses `http://localhost`. The permitted browser origin is Dash0's own app and nothing
      else. Table in design.md.
      Also: there is no wildcard redirect URI, so `http://localhost:*` is not registerable —
      every port needs its own registration.
- [x] 1.4 **Fired.** The browser OAuth flow cannot run from a customer origin, which is d0bar's
      deployment target, so §2 and §4 are not buildable as specified — not a custody problem, a
      no-token problem. Two further findings recorded in design.md: `scopes_supported` is `["*"]`,
      so the scope narrowing cannot be built either; and there is no region-independent issuer.
      Per this task, stop rather than build on it. §2, §4 and §5 are held pending the decision in
      design.md; §3 (worker custody) survives intact and is shared by every option.

## 1b. What the measurement changed
- [ ] 1b.1 `src/auth/discovery.ts` — fetch `/.well-known/oauth-authorization-server`, **not**
      `/.well-known/openid-configuration`, which answers `401` on this server and would be retried
      forever by anything that reads a `401` as "needs a token"
- [ ] 1b.2 Region is an input, not a constant: no `api.dash0.com` exists and the issuer is the
      region. Taken from `D0bar` init config, alongside the endpoint the Web SDK is already given
- [ ] 1b.3 Refuse `https://www.dash0.com/.well-known/oauth-authorization-server` as a bootstrap:
      it answers `200` with a valid document hard-wired to eu-west-1, so a US org gets a working
      document for the wrong region and fails much later
- [ ] 1b.4 Consent copy states that the grant is unrestricted. With one scope and that scope `*`,
      a screen reading "d0bar wants access" understates what is being granted

## 2. authMachine
- [ ] 2.1 `src/auth/authMachine.ts` — `unauthenticated`, `discovering`, `registering`, `awaitingPopup`, `exchanging`, `authenticated`, `refreshing`
- [ ] 2.2 Discovery document fetch and validation
- [ ] 2.3 Dynamic client registration; registration result cached in the worker
- [ ] 2.4 PKCE S256: verifier generation via `crypto.getRandomValues`, challenge via `crypto.subtle`
- [ ] 2.5 `state` generated and verified; mismatch returns to `unauthenticated`
- [ ] 2.6 Popup closed without completing → `unauthenticated`, no partial state retained
- [ ] 2.7 Scopes read from `scopes_supported` and sent as advertised. **Not narrowed** — the
      server advertises exactly `["*"]`, so there is no minimum to narrow to and claiming one
      would be a security property asserted and not held. Read rather than hardcoded so the day
      real scopes ship the toolbar requests them, and so an unexpected list is visible
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
