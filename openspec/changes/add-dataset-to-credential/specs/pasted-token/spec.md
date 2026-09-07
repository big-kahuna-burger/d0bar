## ADDED Requirements

### Requirement: The dataset is part of the credential
A Dash0 token belongs to one dataset, and a query into another dataset returns not-found rather
than an error. The connected credential SHALL therefore carry a dataset alongside the region, and
the worker SHALL hold, persist, clear and report it under the same rules as the region.

#### Scenario: A dataset is chosen at connect time
- **WHEN** the user pastes a token and names a dataset
- **THEN** the worker holds the dataset beside the token and reports it in the connection status

#### Scenario: The dataset field is left blank
- **WHEN** the user connects without naming a dataset
- **THEN** `default` is used, the affordance states that this is what blank means, and the
  status reports `default` rather than an empty value

#### Scenario: Persisted custody
- **WHEN** the token is persisted
- **THEN** the dataset is persisted with it, and a restored token is restored with its dataset

#### Scenario: Session-only custody
- **WHEN** the token is held session-only
- **THEN** the dataset is held in the same realm and is not written to any store

#### Scenario: Disconnecting
- **WHEN** the token is cleared
- **THEN** the dataset returns to `default` and its persisted copy is removed with the token's

#### Scenario: Reconnecting to a different dataset
- **WHEN** the user reconnects to a different dataset while the panel is open
- **THEN** subsequent queries use the new dataset, and no query uses the previous one

### Requirement: Pressing Connect always produces a visible response
Every outcome of pressing Connect SHALL change something the user can see. A failed attempt SHALL
name the failure, and the notice SHALL NOT be written to any element another writer assigns
unconditionally.

#### Scenario: The token field is empty
- **WHEN** Connect is pressed with nothing pasted
- **THEN** the surface says the field is empty, rather than returning silently

#### Scenario: No worker controls the page
- **WHEN** Connect is pressed and no service worker is controlling the page
- **THEN** the surface says so and names the reload that fixes it

#### Scenario: The worker refuses the connection
- **WHEN** a worker is controlling the page and the connection comes back disconnected
- **THEN** the surface says the worker did not accept it and names the region as the cause it
  can check, and does **not** claim there is no worker

#### Scenario: The failure survives the surface re-rendering
- **WHEN** a failure notice has been shown and the connection state is re-rendered
- **THEN** the notice is still readable

## MODIFIED Requirements

### Requirement: The toolbar does not claim to have verified the token's restrictions
The toolbar SHALL state which restrictions a pasted token is required to carry, and SHALL state
that it cannot check them. Because the dataset is now asked for rather than assumed, the
affordance SHALL also state that a wrong dataset is indistinguishable from a missing trace.

#### Scenario: A token is pasted
- **WHEN** the paste affordance is shown
- **THEN** it names the required restrictions — `Reading` permission, one dataset, spans and
  logs — and says that d0bar cannot verify them

#### Scenario: The dataset cannot be verified either
- **WHEN** the paste affordance is shown
- **THEN** it states that d0bar cannot check the dataset name against the token, and that a
  mismatch presents as a trace that is not there

#### Scenario: An over-privileged token
- **WHEN** a token with broader permissions is pasted
- **THEN** the toolbar does not detect it, and does not imply that it did
