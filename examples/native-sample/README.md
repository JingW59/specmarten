# Native backend sample

This walkthrough uses SpecMarten without OpenSpec.

## Initialize

```sh
specmarten init --minimal
```

The generated configuration selects the native backend:

```json
{
  "specBackend": "native"
}
```

## Create a change

The normal AI path is:

```text
$specmarten-run add a status command
```

The session creates a record like:

```text
specmarten/ledger/changes/add-status-command/
  proposal.md
  tasks.md
  specs/status/spec.md
```

`proposal.md` explains why and what changes. `tasks.md` is the completion checklist. `specs/` declares the capability delta used for semantic review.

## Inspect progress

```sh
specmarten status
specmarten next
specmarten validate
```

## Accept and archive

After implementation and verification, the current AI session:

1. completes `tasks.md`;
2. updates the accepted capability document under `specmarten/ledger/specs/status/spec.md`;
3. moves the change to `specmarten/ledger/changes/archive/<date>-add-status-command/`;
4. runs `specmarten closeout`.

The resulting `roadmap.md` and `dashboard.html` are generated from `state.json`; do not edit them manually.

For architecture, compatibility, and backend-selection rules, see [`docs/native-backend.md`](../../docs/native-backend.md).
