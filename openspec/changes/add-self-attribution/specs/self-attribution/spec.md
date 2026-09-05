# self-attribution

## ADDED Requirements

### Requirement: The toolbar measures its own main-thread cost
The toolbar SHALL determine its own contribution to long animation frames from
`long-animation-frame` script attribution, and SHALL display that measured figure.

#### Scenario: Toolbar causes a long frame
- **WHEN** toolbar script appears in a `long-animation-frame` entry's script attribution
- **THEN** that duration is attributed to the toolbar and displayed in the footer

#### Scenario: Toolbar causes no long frames
- **WHEN** no long animation frame contains toolbar script
- **THEN** the footer reports zero

### Requirement: A non-zero cost is disclosed, not hidden
The perturbation figure SHALL never be rounded or floored to zero when measured cost is
non-zero.

#### Scenario: Small but real cost
- **WHEN** the measured self cost is 0.4 ms
- **THEN** the footer shows a non-zero value in the warning colour, not `0.0ms`

### Requirement: Unmeasurable is distinct from zero
Where self cost cannot be measured, the UI SHALL say so rather than displaying zero.

#### Scenario: long-animation-frame unsupported
- **WHEN** the browser does not support `long-animation-frame`
- **THEN** the footer reports the figure as unmeasured and explains why on hover

#### Scenario: Bundled into the host's chunk
- **WHEN** the toolbar's script URL is indistinguishable from the host's bundle
- **THEN** the figure is labelled a lower bound and the attribution method is stated

### Requirement: Zero load-phase cost is verified, not assumed
The toolbar's self-attributed cost during the load phase SHALL be zero.

#### Scenario: Hostile fixture load
- **WHEN** the hostile fixture loads with the toolbar enabled
- **THEN** no long animation frame recorded before settle contains toolbar script
