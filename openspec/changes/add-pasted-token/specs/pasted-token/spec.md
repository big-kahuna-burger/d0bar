# pasted-token

## ADDED Requirements

### Requirement: The token is never returned to the page
No message from the worker SHALL carry the token, and the worker SHALL expose no operation that
returns it.

#### Scenario: The page asks for status
- **WHEN** the page requests connection status
- **THEN** it receives whether a token is stored, where it is stored, and the token's last four
  characters, and not the token

#### Scenario: The page asks for the token directly
- **WHEN** any message requests the stored credential
- **THEN** the worker refuses, and the refusal is not distinguishable from an unknown message

### Requirement: Custody is chosen, and the choice is stated truthfully
The toolbar SHALL offer both a persisted and a session-only custody mode, and SHALL state for
each whether the host page can read the token.

#### Scenario: Persisted custody
- **WHEN** the user chooses to remember the token on the device
- **THEN** it is stored in the worker's IndexedDB, and the affordance states that the host page
  can read it from there

#### Scenario: Session-only custody
- **WHEN** the user chooses session-only
- **THEN** the token is held only in the worker's global scope, is not written to any store,
  and the affordance states that it will need re-pasting when the worker is terminated

#### Scenario: Neither is presented as the safe default
- **WHEN** the paste affordance is first shown
- **THEN** session-only is preselected, and persisting is an explicit action rather than the
  path of least resistance

### Requirement: The toolbar does not claim to have verified the token's restrictions
The toolbar SHALL state which restrictions a pasted token is required to carry, and SHALL state
that it cannot check them.

#### Scenario: A token is pasted
- **WHEN** the paste affordance is shown
- **THEN** it names the required restrictions — `Reading` permission, one dataset, spans and
  logs — and says that d0bar cannot verify them

#### Scenario: An over-privileged token
- **WHEN** a token with broader permissions is pasted
- **THEN** the toolbar does not detect it, and does not imply that it did

### Requirement: The worker calls the API rather than intercepting the page's requests
The worker SHALL issue d0bar's API requests itself and SHALL NOT intercept or respond to
requests made by the page.

#### Scenario: A panel query
- **WHEN** the panel needs data from the Dash0 API
- **THEN** the worker performs the request and returns the result, and no fetch event of the
  page's is responded to

### Requirement: The bearer goes only to the configured API origin
The worker SHALL attach the token only to requests whose origin equals the configured Dash0 API
origin, compared as a parsed origin.

#### Scenario: A query for another origin
- **WHEN** a query names any origin other than the configured one
- **THEN** it is refused without the token being attached, and the refusal is reported to the
  page

#### Scenario: A lookalike origin
- **WHEN** a query names an origin that shares a prefix with the configured one but is not
  equal to it
- **THEN** it is refused

### Requirement: Disconnecting removes the token everywhere
Disconnecting SHALL clear both custody locations.

#### Scenario: Disconnect
- **WHEN** the user disconnects
- **THEN** the in-memory copy and the stored copy are both removed, and status reports
  disconnected

### Requirement: Capability loss while unconnected is explicit
Features requiring the token SHALL be visibly unavailable with a reason rather than failing
silently.

#### Scenario: A query while unconnected
- **WHEN** the panel needs the API and no token is held
- **THEN** the panel explains that connecting is required, and does not present the absence as
  an empty result
