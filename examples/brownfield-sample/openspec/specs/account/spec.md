# Account Spec

## Purpose
Define account access behavior for a small brownfield example project.

## Requirements

### Requirement: Login
Users MUST be able to sign in with a local account.

#### Scenario: Local account login succeeds
- **WHEN** a user submits valid local account credentials
- **THEN** the account subsystem SHALL authenticate the user
