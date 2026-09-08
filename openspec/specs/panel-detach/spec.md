# panel-detach Specification

## Purpose
TBD - created by archiving change add-panel-detach. Update Purpose after archive.
## Requirements
### Requirement: The panel can leave the host document
The panel SHALL be detachable into a picture-in-picture window, leaving only the pill in the
host document.

#### Scenario: Detached and driven
- **WHEN** the panel is detached and then driven through tabs and a trace view
- **THEN** the host document contains only the pill, and no layout or paint work in the host
  document is attributable to the toolbar

### Requirement: Detach is progressive
The detach affordance SHALL be hidden where the platform does not support it, and failure to
detach SHALL leave a working in-page panel.

#### Scenario: Unsupported browser
- **WHEN** picture-in-picture documents are unavailable
- **THEN** no detach affordance is shown and the in-page panel behaves normally

#### Scenario: Detach refused
- **WHEN** the request for a window fails or one is already open
- **THEN** the panel stays in-page and explains why

### Requirement: State survives the transition
Detaching and re-attaching SHALL preserve the current view, active tab, scroll position and
selected request.

#### Scenario: Detach mid-inspection
- **WHEN** the panel is detached while a trace is displayed
- **THEN** the same trace is displayed in the detached window

#### Scenario: Detached window closed
- **WHEN** the picture-in-picture window is closed
- **THEN** the panel returns in-page with its prior view, tab, scroll and selection

### Requirement: A detached panel never outlives its page
The detached window SHALL close when the host page navigates away.

#### Scenario: Host navigates while detached
- **WHEN** the host page navigates
- **THEN** the detached window closes rather than describing a page that no longer exists

### Requirement: Observation stays in the host realm
The collector SHALL remain in the host page while the panel is detached.

#### Scenario: Requests during detach
- **WHEN** the host page issues requests while the panel is detached
- **THEN** those entries are still recorded and appear in the detached panel

