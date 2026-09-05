# Design — panel detach

## The split
| Realm | Holds | Why there |
| --- | --- | --- |
| Host page | collector, ring, observers, pill | only this realm receives the host's performance entries |
| PiP window | panel DOM, views, worker client | so panel rendering is not the host document's work |

The reactive core lives in the host realm and drives nodes in the PiP document across the realm
boundary — both documents are same-origin, so direct node manipulation works. The alternative,
duplicating state into the PiP window and syncing, adds a protocol for no benefit.

Consequence to watch: nodes created with the host document's `createElement` and adopted into
the PiP document must be created from the PiP document instead, or styles resolve against the
wrong document. The panel is rebuilt from its template into the target document on each
transition rather than being moved node by node.

## Stylesheets
`adoptedStyleSheets` must be set on the PiP document's shadow root. Constructed stylesheets are
per-document, so the token sheet is rebuilt for the PiP document — cheap, and it happens once
per detach.

## Lifecycle
- Detach: open PiP window, build the panel into it, close the in-page popover.
- Re-attach: on PiP window close, on host navigation, or on user request.
- Host navigation while detached closes the PiP window — a stale panel describing a page that
  no longer exists is worse than no panel.
- Only one PiP window per document is permitted by the API; the affordance reflects that.

## Why this is the strong form of the guarantee
While detached, the host document contains one fixed 34px button and no panel. There is no
layout, paint, or style work for the host to do on behalf of the toolbar, and the claim is
verifiable by measurement rather than by reading the implementation.

## Rejected
- **A plain popup window** — same isolation benefit, much worse UX, no always-on-top.
- **Detaching by default** — a surprising window is a bad first impression. Opt-in.
- **Moving the collector into the PiP window** — it would no longer see the host's entries.
