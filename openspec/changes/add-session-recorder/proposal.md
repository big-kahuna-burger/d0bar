# add-session-recorder

## Why
The toolbar answers "why is this page slow?" for the person looking at it, right now. The
moment they want to *show someone else*, they screenshot it — and a screenshot of a waterfall
is the one artefact that cannot be re-examined.

The data is already sitting in the ring. A recorder is not new collection, it is a copy of a
buffer that already exists plus enough context to read it back. That framing is the whole
design: **recording must add nothing to the observation path.**

The failure mode to design against is obvious and worth naming. A recorder that streams, that
uploads, that runs by default, or that captures the DOM is no longer a toolbar — it is a RUM
agent, and it would break the one constraint this project has. So the scope is deliberately
narrow: an explicit user gesture, an in-memory copy, a file the user chooses to save.

## What Changes
- **Explicit start only.** No recording without a click. No autostart flag, no "always record
  the last N seconds" mode — that is a ring the customer did not consent to paying for.
- **A copy, not a tap.** `startRecording()` snapshots the ring's current contents and marks a
  start index; `stopRecording()` copies the slots written since. `pushResource` is not touched,
  so the hot path is identical whether or not a recording is running.
- **Bounded by construction.** A recording cannot outlive the ring: 512 records is the ceiling,
  and overflow during a recording is reported as `dropped`, never silently truncated.
- **The session file** — `.d0bar.json`, gzipped via `CompressionStream`: schema version, the
  epoch set, interned string tables, the record columns, vitals with attribution, the tier
  states at capture time, and the browser's capability set.
- **Provenance travels with it.** A file captured on a browser without `deliveryType` carries
  `F_CACHE_INFERRED` on those records and the reader must render them as inferred. A recording
  that loses its provenance is a recording that lies more confidently than the live panel.
- **Replay into the existing views.** The panel reads a session file through the same interface
  it reads the live ring, so the waterfall, vitals and untraced views need no recorder-specific
  code. A replayed session is visibly marked as one.
- **Saved, never sent.** The file is produced with `showSaveFilePicker()` where available and a
  blob download otherwise. Nothing is uploaded. There is no endpoint.

## Explicit non-goals
- **No DOM, input, or screen recording.** Not a session replay tool. Anything that captures
  what the user typed is a privacy surface this project will not open.
- **No continuous buffer or background upload.** Both turn the toolbar into an agent.
- **No redaction promises.** URLs and headers are recorded as the browser reported them, and
  the UI must say so before the save — a recorder that claims to have scrubbed PII and missed
  some is worse than one that is honest about scrubbing nothing.

## Open questions
- Does the recorder belong in stage 2 (panel-only, zero cost when closed) or stage 3? Stage 2
  is simpler and the recorder is useless without the panel; stage 3 keeps the panel smaller.
  **Leaning stage 3** — the panel is on the click path, and the recorder is not.
- Should a recording capture the *whole* ring or only slots written after `start`? Whole-ring
  is more useful (the slow request usually happened before you thought to record) but makes
  "recording" a misleading verb. **Leaning whole-ring, labelled as a capture rather than a
  recording.**

## Impact
- New capability: `session-recorder`
- New: `src/recorder/`, `src/shared/session.ts`
- Depends on: `add-epoch-model` (a session without epochs cannot be read back), and on
  `add-requests-view` / `add-vitals-view` for anything to replay into
- Touches: `src/collector/ring.ts` — read-only export helpers, no change to `pushResource`
- Budget: stage 3, outside budgets A and B. Must add **zero** bytes to stage 1 and must not
  register an observer, a listener, or a timer of its own
