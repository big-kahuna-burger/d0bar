# Tasks — panel detach

## 1. Capability detection
- [x] 1.1 Feature-detect `documentPictureInPicture`; hide the affordance entirely where absent
- [x] 1.2 Detect the one-window-per-document limit and reflect it in the affordance state
- [x] 1.3 Record detach support in the tier/diagnostics surface

## 2. Detach
- [x] 2.1 `src/panel/detach.ts` — `requestWindow()` sized from the panel's own dimensions
- [x] 2.2 Move the live panel into the PiP document so bindings and in-flight work survive; use a
      destination-owned shadow root and stylesheet
- [x] 2.3 Rebuild the token stylesheet as a `CSSStyleSheet` of the PiP document; adopt into its shadow root
- [x] 2.4 Close the in-page popover on successful detach; leave the pill in place
- [x] 2.5 Bind the reactive core across realms; assert no state duplication and no sync protocol
- [x] 2.6 Keyboard shortcut works from either window

## 3. Re-attach
- [x] 3.1 On PiP `pagehide` → move the panel back to the host document, preserving view, tab,
      scroll and selection
- [x] 3.2 Host navigation while detached → close the PiP window
- [x] 3.3 Explicit re-attach affordance in the PiP window
- [x] 3.4 Detach failure (blocked, or a window already open) → stay in-page with an explanation
- [x] 3.5 Worker client survives the transition; an in-flight trace query is not lost

## 4. Budget
- [x] 4.1 Budget row: host main-thread cost while detached and driven hard
- [x] 4.2 Playwright: detach, drive the panel, assert zero host layout and zero host paint attributable to the toolbar
- [x] 4.3 Assert the host document contains only the pill element while detached
