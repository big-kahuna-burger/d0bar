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
- [ ] 5b.1 The worker went 3.99 kB → 8.22 kB raw, 1.39 → 2.53 kB gzip, and **nothing gates it**:
      `.size-limit.json` covers the two stage-1 artifacts and the panel, not the worker. That is
      not a licence — it is a missing budget, and it should be added rather than left as the one
      bundle that can grow unobserved. Registered post-settle, so it is not on the critical path,
      which is why this is a gap and not a regression

## 6. UI
- [ ] 6.1 `src/panel/views/connect/` — paste field, custody choice, required restrictions,
      the unverifiable note
- [ ] 6.2 Connected state in the panel header, showing the hint and the custody mode
- [ ] 6.3 Disconnect
- [ ] 6.4 Features needing the API are unavailable with a reason while unconnected

## 7. Withdraw the false claim
- [ ] 7.1 `add-credential-broker` design.md — mark the custody table's "readable by host page:
      no" as withdrawn, with the reason and the evidence, rather than deleting it
