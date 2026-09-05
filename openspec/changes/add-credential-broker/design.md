# Design — credential broker

## Custody
| Holder | Holds | Readable by host page |
| --- | --- | --- |
| Page JS | an opaque session handle | yes, and useless alone |
| Service worker IndexedDB | access token, refresh token, PKCE verifier | **no** |

The page asks the worker to make a call; the worker attaches the bearer. A host page that reads
everything d0bar puts in the page realm still cannot obtain a credential.

When the worker is unavailable, there is no safe degradation for token custody. The correct
behaviour is to refuse to authenticate and say why — not to fall back to `localStorage`, which
would silently hand the token to the host page.

## One refresh, many tabs
Two layers, both required:
- **In-tab**: refresh is an invoked actor. Concurrent 401s are queued as events and the machine
  is already in `refreshing`, so only one request is issued.
- **Cross-tab**: `navigator.locks.request()` around the refresh. The lock holder refreshes and
  publishes the result on a `BroadcastChannel`; other tabs adopt it without issuing their own.

Signing in once therefore authenticates every open tab.

## Scopes
Read from the discovery document's `scopes_supported` and narrowed to the minimum that reads
spans and logs. Never hardcoded — a hardcoded scope list breaks silently when the server's
changes, and over-requests in the meantime.

## Redirect URI
Dynamic registration means registering the customer's own origin. Confirm arbitrary https
origins and `http://localhost:*` are accepted before building on it.

## Rejected
- **Reusing the SDK's `authToken`** — ingest-only, unusable for reads.
- **Tokens in `localStorage` or a page-realm variable** — readable by the host page, which is
  the exact weakness this change exists to close.
- **Refresh without a lock** — a refresh-token rotation race logs the user out of every tab.
