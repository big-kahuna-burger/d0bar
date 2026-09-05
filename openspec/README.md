# OpenSpec

`specs/` is the deployed truth — empty until a change is archived.
`changes/<id>/` is a proposed change: `proposal.md` (why/what), `design.md` (trade-offs, only
where a decision needs recording), `tasks.md` (the work), `specs/<capability>/spec.md` (the
requirement delta).

Deltas use `## ADDED Requirements` with `### Requirement:` (SHALL) and `#### Scenario:`
(WHEN/THEN). On archive, the delta merges into `specs/<capability>/spec.md`.

## Order
Dependencies, not a schedule. 1 and 2 land together — 2 is the acceptance gate for 1.

```
1  add-observation-core ──┬── 3 add-panel-shell ──┬── 4 add-requests-view
2  add-perturbation-budget┘                       ├── 5 add-vitals-view
                                                  ├── 6 add-self-attribution
                                                  └── 12 add-panel-detach
   7 add-sw-correlator ── 8 add-untraced-view
   9 add-trace-layout-worker ── 10 add-trace-view ── 11 add-credential-broker
```

Changes 1–6 ship a useful product with no auth, no service worker, and no backend call.
