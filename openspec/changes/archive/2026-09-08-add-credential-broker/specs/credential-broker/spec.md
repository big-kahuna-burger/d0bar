# credential-broker

## ADDED Requirements

### Requirement: The page never holds a credential
Access and refresh tokens SHALL be stored only in the service worker's own storage, and SHALL
never be present in the page realm.

#### Scenario: Host page inspects everything it can reach
- **WHEN** the host page enumerates page-realm state, storage, and every message the toolbar
  posts
- **THEN** no access token, refresh token, or PKCE verifier is obtainable

#### Scenario: An authenticated API call
- **WHEN** the toolbar queries the Dash0 API
- **THEN** the worker attaches the bearer, and the page-side code never sees it

### Requirement: No unsafe degradation of custody
Where the service worker is unavailable, the toolbar SHALL refuse to authenticate rather than
storing a credential where the host page can read it.

#### Scenario: No worker scope
- **WHEN** authentication is attempted with no service worker available
- **THEN** it is refused with an explanation, and no token is written to page-realm storage

### Requirement: Exactly one refresh across all tabs
Concurrent authorization failures SHALL result in exactly one refresh request.

#### Scenario: Three tabs receive 401 at once
- **WHEN** three open tabs each receive a 401 simultaneously
- **THEN** one refresh request is issued, and all three tabs adopt its result

#### Scenario: Refresh rejected
- **WHEN** the refresh token is rejected
- **THEN** every tab returns to unauthenticated

### Requirement: Scopes are discovered, not hardcoded
Requested scopes SHALL be derived from the server's advertised scopes, and the toolbar SHALL
NOT claim a narrowing it did not obtain.

The server advertises exactly `["*"]`, so there is no narrowing available today. Reading the
list rather than hardcoding it is what makes the toolbar request real scopes on the day they
exist.

#### Scenario: Server advertises scopes
- **WHEN** the discovery document is read
- **THEN** the requested scopes are a subset of `scopes_supported`

#### Scenario: The only advertised scope is unrestricted
- **WHEN** `scopes_supported` offers no scope narrower than full access
- **THEN** the consent affordance states that the grant is unrestricted, rather than describing
  it as access limited to reading telemetry

### Requirement: Discovery is OAuth, and regional
The toolbar SHALL read authorization server metadata from the RFC 8414 endpoint on the
organization's own regional issuer.

#### Scenario: Discovery endpoint
- **WHEN** the toolbar discovers the authorization server
- **THEN** it reads `/.well-known/oauth-authorization-server`, and does not treat a `401` from
  `/.well-known/openid-configuration` as a condition to retry or authenticate against

#### Scenario: No region configured
- **WHEN** no region is configured
- **THEN** the toolbar states that it cannot determine the organization's endpoint, and does not
  fall back to a region-independent host

### Requirement: An abandoned sign-in leaves no state
An incomplete authorization SHALL leave no partial credential or verifier behind.

#### Scenario: Popup closed early
- **WHEN** the user closes the authorization popup without completing
- **THEN** the machine returns to unauthenticated and no verifier or partial token is retained

#### Scenario: State mismatch
- **WHEN** the returned `state` does not match the generated one
- **THEN** the exchange is refused and the attempt is discarded

### Requirement: Unauthenticated capability loss is explicit
Features requiring a credential SHALL be visibly disabled with a reason while unauthenticated.

#### Scenario: Trace jump without auth
- **WHEN** a request row is opened while unauthenticated
- **THEN** the panel explains that connecting is required, rather than failing silently
