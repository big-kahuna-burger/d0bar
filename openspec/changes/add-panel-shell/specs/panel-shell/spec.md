# panel-shell

## ADDED Requirements

### Requirement: Panel code is off the critical path
Panel code SHALL NOT be fetched, parsed, or executed until the panel is first opened, other
than a background-priority prefetch that begins only after the load phase has settled.

#### Scenario: Page loads, panel never opened
- **WHEN** the host page loads with the toolbar enabled and the user does not open the panel
- **THEN** no panel module is requested during the load phase

#### Scenario: Prefetch after settle
- **WHEN** the load phase settles
- **THEN** the panel module is fetched at background priority, and a failure to prefetch does
  not surface an error or prevent opening

### Requirement: Isolation is enforced by the platform
The toolbar SHALL render inside a closed shadow root with styles supplied only through
`adoptedStyleSheets`, and SHALL declare `contain: layout paint style`.

#### Scenario: Host attempts to reach in
- **WHEN** host page script queries for the toolbar's internals
- **THEN** the shadow root is not accessible and host CSS selectors do not match toolbar nodes

#### Scenario: Host has an aggressive stacking context
- **WHEN** the host page has a transformed or filtered ancestor that would trap a positioned
  element
- **THEN** the panel still renders above host content, because it is in the browser's top layer

### Requirement: The observation stack is always visible and honest
The footer SHALL show all four tiers at once, each in one of live, off, or planned, and SHALL
never present an inactive tier as active.

#### Scenario: Tier 2 unavailable
- **WHEN** the service worker scope cannot be obtained
- **THEN** tier 2 renders as off with the host-owns-the-scope explanation, and the perturbation
  label reads `degraded — no trace jump`

#### Scenario: Unimplemented tiers
- **WHEN** the panel is opened
- **THEN** tiers 3 and 4 render in the planned state and are not represented as supplying data

### Requirement: Keyboard operation
The panel SHALL be operable by keyboard, with a toggle shortcut available before panel code has
loaded.

#### Scenario: Shortcut pressed before first open
- **WHEN** `⌘⇧0` is pressed and the panel module has not loaded
- **THEN** the module loads and the panel opens

#### Scenario: Escape from the trace view
- **WHEN** Escape is pressed while a trace is displayed
- **THEN** the list view returns with its scroll position and active tab intact, and a second
  Escape closes the panel

#### Scenario: Focus returns
- **WHEN** the panel closes
- **THEN** focus returns to the pill

### Requirement: Tooltips are reachable without a pointer
Every tooltip SHALL open on keyboard focus as well as hover, and SHALL be dismissable with Escape.

#### Scenario: Tabbing to a tier label
- **WHEN** a tier label receives keyboard focus
- **THEN** its explanation opens, and Escape dismisses it

### Requirement: Motion is compositor-only and respects preference
Animations SHALL use only `transform` and `opacity`, and SHALL degrade when reduced motion is
requested.

#### Scenario: Reduced motion
- **WHEN** `prefers-reduced-motion: reduce` is set
- **THEN** the panel fades without transform and the ingest-lag dots do not pulse
