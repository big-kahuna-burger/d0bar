# Tasks — pasted token

## 1. Worker custody
- [x] 1.1 `src/sw/token.ts` — `set(token, persist)`, `clear()`, `status()`, `bearer()`
- [x] 1.2 Memory is the only holder for session-only. **Claim corrected while building**: the
      first version said "touches no store at all" and its own test failed it — choosing
      session-only after having persisted must *delete* the earlier copy, which means opening
      the store. The guarantee is that the token is never *written*, and that the earlier copy
      goes; both are asserted by reading the store the way the host page would
- [x] 1.3 Persisted mode writes to the worker's IndexedDB, in its own store, version-bumped
- [x] 1.4 `status()` returns `{ connected, source, hint }` — `hint` is the last four characters
- [x] 1.5 No exported function returns the token; `bearer()` is module-internal to `query.ts`
- [x] 1.6 A token restored from IndexedDB on worker restart reports `source: "stored"`

## 2. The allowlisted call
- [x] 2.1 `src/sw/query.ts` — parse the requested URL, compare `origin` against the configured
      API origin, refuse anything else
- [x] 2.2 Origin comparison, never `startsWith` — `https://api…dash0.com.evil.test` must fail
- [x] 2.3 Attach `Authorization: Bearer <token>`; no cookies, since the API answers
      `access-control-allow-origin: *` and `credentials: 'include'` is therefore illegal
- [x] 2.4 A refusal is returned to the page as a refusal, not as an empty result
- [x] 2.5 A `401` from the API surfaces as "the token was rejected", distinct from a transport
      failure

## 2b. The region
- [x] 2b.1 `src/shared/regions.ts` — a compiled table of `{ id, env, label, origin }`, built from
      two independent sources that agree. **The configuration**: `dash0hq/dash0-configuration`,
      `platform/environments/<cloud>/`, one file per deployed cluster suffixed by role. Only
      `-regional` clusters are customer-facing; `-global` is the control plane (the regional
      values say so: "No org-whois here: it needs a control-plane-api address, which only the
      global clusters run") and `-syn`/`-synthetics` are check runners. Six `-regional` clusters
      exist. **The probe**: all six confirmed live, three ways — `issuer` equal to their own
      origin, `GET /api/spans` -> `401` (not `404`, which is what separates a region serving the
      data API from a name that merely resolves), and `OPTIONS /api/spans` from a foreign origin
      asking for `Authorization` -> `204` with `access-control-allow-origin: *`:
      `api.{eu-west-1,eu-central-1,us-west-2}.aws.dash0.com`,
      `api.europe-west4.gcp.dash0.com`,
      `api.eu-west-1.aws.dash0-dev.com`, `api.europe-west4.gcp.dash0-dev.com`.
      The preflight result is the one that matters most: the data API accepts a cross-origin
      bearer where the OAuth endpoints refuse one, which is the whole reason this change exists
      instead of `add-credential-broker`
- [x] 2b.1b Neither source alone was sufficient, which is why both are recorded. A DNS sweep of
      AWS region names found four and missed two — GCP regions are named `europe-west4`, not
      `eu-west-1`, so a sweep built from AWS names cannot see them; certificate transparency
      named the pattern. Going the other way, certificates alone would have listed two names
      that are not regions: `us-east-2` (a wildcard cert and a `production-us-east-2-global`
      cluster, but no `api.` host resolves — it is the production control plane) and
      `api.dash0.com` (a cert, no DNS). There is still no region-independent issuer
- [x] 2b.1a Ids are environment-qualified (`prod:eu-west-1`), because the region names repeat
      across environments and a bare `eu-west-1` names two different origins
- [x] 2b.2 The connect message carries a region **id**, never a URL. The worker resolves it
      against its own copy of the table, so a page cannot name an origin of its own
- [x] 2b.3 An unknown id is refused, and the refusal clears rather than leaves the previous
      connection live. **Found by its own test**: the first version returned the current status,
      which reported "not connected" while the earlier region's token was still being attached
- [x] 2b.4 The id is persisted next to the token and restored with it; an id no longer in the
      table leaves the token unrestored rather than aimed at a default
- [x] 2b.5 `TokenStatus.apiOrigin` reports where the token will actually go, so a refused region
      is visible in the panel instead of silent
- [x] 2b.6 A `<select>` in the connect surface, with the region's origin spelled out under it —
      the label says "EU (Ireland)", and what a developer checks against their tenant is the URL
- [x] 2b.6a A dev/prod toggle above it, `prod` default. Two buttons rather than a third
      `<select>`: there are exactly two environments and both should stay visible. The region
      control is rebuilt from the toggle, and `dev` — carrying one region — states its region
      instead of rendering a one-option `<select>` nobody can operate. The dev note is styled as
      a warning because it is one: a production token is rejected there and the rejection is
      indistinguishable from a revoked token
- [x] 2b.7 `window.D0BAR_REGION` preselects both the toggle and the picker for debugging. A preselection only: it
      names an id the worker still resolves, so an unknown value falls back to the default
      rather than adding a destination. Fixture gate: `?region=<id>`
- [x] 2b.8 The broker installs unconditionally; `?api=<origin>` on the worker's script URL is
      now an *addition* to the table for a self-hosted or preview endpoint, not the thing that
      makes the broker exist. Host-controlled at build time, which is why it may be arbitrary
      where the picker may not

## 3. The message boundary
- [x] 3.1 `message` listener in `src/sw/d0bar-sw.ts` and `src/sw/module.ts`
- [x] 3.2 Messages: `connect`, `disconnect`, `status`, `query`. Nothing else, and an unknown
      message is ignored rather than echoed
- [x] 3.3 Replies go over the `MessagePort` the page supplies, not broadcast to all clients
- [x] 3.4 A note in `protocol.ts` recording why a message protocol is right here and wrong for
      the log — the load-path argument does not apply to a user-initiated paste
- [x] 3.5 `respondWith` is not used. Verified against the built artifacts, not just the source:
      `grep -c respondWith dist/d0bar-sw.js dist/d0bar-sw-module.js` → `0` and `0`

## 4. Tests
- [x] 4.1 Unit: the token never appears in any reply object, for every message type
- [x] 4.2 Unit: session-only writes nothing; persisted writes and restores
- [x] 4.3 Unit: lookalike-origin refusal, and the parsed-origin comparison
- [x] 4.4 Unit: disconnect clears both locations
- [x] 4.4a Unit: an unknown region id is refused and leaves nothing connected; a query goes to
      the connected region and is refused for every other; the region restores with the token
- [x] 4.4b Unit: the picker offers the compiled table and nothing else, the origin line is
      derived from the selection, and an unknown `D0BAR_REGION` falls back to the default.
      In jsdom rather than a browser spec: the `<select>` is in a closed shadow root and its
      dropdown is painted by the OS outside the page, so no driver can reach either
- [ ] 4.5 **Not done.** No browser test yet. The unit tests assert the message surface never
      returns the token; what is unasserted is the same claim against a real registration, with
      a real page realm to search

## 5. Measure, do not assume
- [ ] 5.1 Probe how long an idle service worker survives in this Chromium, so the session-only
      copy's real cost is a number and not the ~30s everyone quotes
- [ ] 5.2 Probe what `Origin` a worker-initiated `fetch` sends to a cross-origin API — origin
      allowlisting is what killed the OAuth path, and this change assumes it does not bite here
- [ ] 5.3 Record both in design.md

## 5b. Unbudgeted growth
- [x] 5b.1 Budget added — `dist/d0bar-sw.js` at 3 kB gzip, in both `.size-limit.json` and
      `bench/budget.json` with the rationale. Measured 2.07 kB by size-limit, which re-minifies
      with esbuild and is the number gated; vite's terser pass reports 2.53 kB for the same
      artifact. Both are recorded, because quoting one of them alone is how the next person
      concludes the budget moved when it did not. The worker went 3.99 kB → 8.22 kB raw, 1.39 → 2.53 kB gzip, and **nothing gates it**:
      `.size-limit.json` covers the two stage-1 artifacts and the panel, not the worker. That is
      not a licence — it is a missing budget, and it should be added rather than left as the one
      bundle that can grow unobserved. Registered post-settle, so it is not on the critical path,
      which is why this was a gap and not a regression

## 6. UI
- [ ] 6.1 `src/panel/views/connect/` — paste field, custody choice, required restrictions,
      the unverifiable note
- [ ] 6.2 Connected state in the panel header, showing the hint and the custody mode
- [ ] 6.3 Disconnect
- [ ] 6.4 Features needing the API are unavailable with a reason while unconnected

## 7. Withdraw the false claim
- [x] 7.1 Withdrawn in all three places it was claimed, and kept rather than deleted so the
      correction stays legible: the custody table in design.md, the §3 heading in tasks.md, and
      the proposal's "the page's JavaScript never holds the token". Also withdrawn: the claim
      made during the §1.3 write-up that §3 survived the OAuth finding intact. It did not.
