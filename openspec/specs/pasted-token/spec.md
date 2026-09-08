# pasted-token

## Purpose

Gives the panel a credential for the Dash0 API by asking the developer to paste an auth token,
holding it in the service worker rather than the page, and sending it only to the API origin of
the region they selected. It exists because Dash0's sign-in flow refuses browser requests from
any origin but its own app, so a toolbar cannot obtain a token on the developer's behalf — and
because every custody guarantee a browser can actually offer here is narrower than it first
appears, this capability is as much about stating the limits truthfully as about the mechanism.
## Requirements
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

### Requirement: The worker calls the API rather than intercepting the page's requests
The worker SHALL issue d0bar's API requests itself and SHALL NOT intercept or respond to
requests made by the page.

#### Scenario: A panel query
- **WHEN** the panel needs data from the Dash0 API
- **THEN** the worker performs the request and returns the result, and no fetch event of the
  page's is responded to

### Requirement: The user chooses the environment and the region, from a fixed list
The connect surface SHALL let the user select a Dash0 environment and a region within it, and
what crosses to the worker SHALL be an identifier the worker resolves against its own compiled
table — never an origin supplied by the page.

#### Scenario: Switching environment
- **WHEN** the user changes the environment
- **THEN** the region control offers only that environment's regions, a region selected in the
  other environment is not carried across, and the non-production environment is presented as a
  warning that names the failure it causes — a rejection indistinguishable from a revoked token

#### Scenario: Selecting a region
- **WHEN** the user picks a region and connects
- **THEN** the worker resolves the identifier to that region's API origin and reports the origin
  back, and the surface shows the origin alongside the region's name

#### Scenario: An identifier the worker does not carry
- **WHEN** a connect message names a region the compiled table does not contain
- **THEN** the worker refuses it, holds no token, and reports disconnected — it does not fall
  back to a default region or to a previously selected one

#### Scenario: A region outside the table
- **WHEN** the host registers the worker with an explicit API origin on the worker's own script
  URL
- **THEN** that origin becomes selectable in addition to the compiled table

### Requirement: The bearer goes only to the connected region's API origin
The worker SHALL attach the token only to requests whose origin equals the API origin of the
region the token was connected for, compared as a parsed origin.

#### Scenario: A query for another origin
- **WHEN** a query names any origin other than the connected region's
- **THEN** it is refused without the token being attached, and the refusal is reported to the
  page

#### Scenario: A query for a different Dash0 region
- **WHEN** a query names a Dash0 region other than the connected one
- **THEN** it is refused — a region in the table is not thereby a destination for a token
  connected elsewhere

#### Scenario: A lookalike origin
- **WHEN** a query names an origin that shares a prefix with the connected region's but is not
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
