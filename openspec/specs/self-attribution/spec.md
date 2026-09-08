# self-attribution Specification

## Purpose
TBD - created by archiving change add-self-attribution. Update Purpose after archive.
## Requirements
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

### Requirement: The attribution mechanism proves it is alive
Attribution SHALL distinguish frames recognised by the toolbar's reserved function-name mark
from frames recognised by script URL, and SHALL expose the count of the former.

A URL match alone cannot detect its own failure: with the marks dead, every count and total
stays confidently non-zero, and the panel's own cost — a separate bundle at a separate URL —
is silently dropped. The mark is also the only discriminator that exists when the toolbar is
bundled into the host's chunk.

#### Scenario: Marks removed by a build change
- **WHEN** the reserved mark no longer reaches the browser as `sourceFunctionName`
- **THEN** the marked-frame count is zero and CI fails, even though the total is non-zero

### Requirement: Zero load-phase cost is verified, not assumed
The toolbar's self-attributed cost during the load phase SHALL be zero.

#### Scenario: Hostile fixture load
- **WHEN** the hostile fixture loads with the toolbar enabled
- **THEN** no long animation frame recorded before settle contains toolbar script

