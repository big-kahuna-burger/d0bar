# add-pasted-token

## Why
`add-credential-broker` cannot be built. Its §1.3 verification found that Dash0's OAuth
endpoints are origin-allowlisted: `POST /oauth/register` and `POST /oauth/token` answer `403`
to any request carrying a customer `Origin`, on production and on dev. The browser flow is
reachable from Dash0's own app and nothing else, so a toolbar on a customer's page cannot
register a client, exchange a code, or refresh.

The data plane is open. `GET /api/spans` from `https://shop.example.com` reaches the
application and answers `401` for want of a bearer, with CORS headers on the response. So a
page that *has* a token can read telemetry — it just cannot obtain one through OAuth.

That leaves the credential Dash0 already issues: an admin-minted `auth_…` token, restricted to
`Reading`, to one dataset, and to spans and logs. The developer pastes it once.

## What Changes
- A paste affordance in the panel. The token goes to the service worker and the page keeps
  nothing.
- The worker holds it and makes d0bar's API calls itself, returning data. It does **not**
  intercept the page's requests — `respondWith` stays banned, and this change does not touch
  that ban.
- Two custody choices, both stated plainly at the point of paste: remember on this device
  (worker IndexedDB, which the host page can read if it tries) or this session only (worker
  memory, which it cannot).
- The token's own restrictions are the security boundary. The UI says which restrictions are
  required and says that d0bar cannot verify them.

## Impact
- New capability: `pasted-token`
- New: `src/sw/token.ts`, `src/sw/query.ts`, `src/panel/views/connect/`
- Depends on: `add-sw-correlator` (the worker)
- **Corrects `add-credential-broker`**: that change's custody table claims the worker's
  IndexedDB is not readable by the host page. It is. All same-origin storage is shared with the
  page — `src/sw/protocol.ts` says so in its own words, and tier 2 depends on it. The claim is
  withdrawn rather than restated here.
- Does **not** supersede the broker. If Dash0 allowlists customer origins, OAuth is still the
  better credential; this change is what works today.
