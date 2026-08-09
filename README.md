# SpecMarten

SpecMarten is a small project-level governance tool for shared human and AI
coding sessions. It can use its own native change ledger or remain an OpenSpec
companion for repositories that already use OpenSpec. SpecMarten keeps the shared
project layer around individual changes:

- roadmap and current direction
- task progress linked to change-ledger records
- generated `specmarten/roadmap.md` and `specmarten/dashboard.html`
- drift/check context for AI-assisted coding sessions
- a short "what should I do next?" command

SpecMarten is client-first by default: the current AI session does the semantic
work, while the CLI provides deterministic context, validation, state writes, and
generated views.

OpenSpec integration is independent companion tooling. SpecMarten is not affiliated with,
endorsed by, sponsored by, or maintained by OpenSpec or its maintainers.

## Status

Install from npm:

```sh
npm install -g specmarten
specmarten --help
```

For source checkout evaluation or development:

```sh
git clone https://github.com/JingW59/specmarten.git
cd specmarten
npm ci
npm run build
node bin/specmarten.js --help
```

## Start

Initialize SpecMarten in your repository:

```sh
specmarten init
```

That's the whole setup. `init` detects an existing `openspec/` directory and
selects the OpenSpec backend automatically; otherwise it bootstraps the native
ledger. It renders the first views, writes `.specmarten.json`, and installs
AI-session files (Codex, Claude Code, git hook) when the matching tool is
detected. Use `--minimal` to skip integrations, or `--bootstrap` to force an
OpenSpec project.

See [Native backend architecture and workflow](docs/native-backend.md) for the
data model, backend-selection rules, lifecycle, compatibility boundary, and
verification gates. A minimal walkthrough is available in
[`examples/native-sample/`](examples/native-sample/).

## How it works

SpecMarten is **client-first by default**: the current AI session does the
semantic work, while the CLI provides deterministic context, validation, state
writes, and generated views. Headless/automation mode is available but optional
(see [Advanced](#advanced)).

The project layer has three zoom levels — you don't need all of them to start:

```
Roadmap (macro)        Streams → Phases → Tasks
                          │        │        └── linked to ──┐
                          │        │                         │
Change ledger (micro)  proposal.md, tasks.md, spec deltas ◀─┘
                          │
Generated views        specmarten/roadmap.md, dashboard.html, baseline/
```

- A **change** (proposal + tasks + spec deltas) is the unit of work.
- A **roadmap** (streams → phases → tasks) links changes to direction.
- **Generated views** (`roadmap.md`, `dashboard.html`) are read-only outputs.

You can start with just a change ledger and add the roadmap later — empty
streams are a first-class state.

## Workflow

The shortest rule: **run `specmarten next` and follow the one command it prints.**

Every lifecycle command prints its recommended next step, so you rarely need to
memorize the full set. The common path is:

```sh
specmarten init              # one-time setup
$specmarten-plan ...         # draft the roadmap (AI session), then:
specmarten promote           # accept the draft

# per change:
$specmarten-run ...          # end-to-end: change + code + verify + refresh
specmarten archive <id>      # native: move the change into the archive
specmarten closeout          # reconcile, refresh baseline, validate
```

`$specmarten-run` is the end-to-end AI path: it creates or updates a change in
the configured ledger, implements the code, runs verification, refreshes
SpecMarten state, renders views, and reports the result. It does not commit,
tag, publish, or push unless you explicitly ask for that.

### Commands

Top-level commands are grouped in `specmarten --help`. The high-frequency ones:

| Command | Purpose |
| --- | --- |
| `next` | Prints the next recommended action for the current state. Start here when unsure. |
| `init` | One-time setup; detects OpenSpec or bootstraps native. |
| `status` | Read-only progress, drift, and maintenance snapshot. `--summary-json` for automation. |
| `validate` | Validates state, generated views, config, agents, and baseline. `--fix` regenerates stale views; `--complete` gates on finished checklists. |
| `dashboard` | Regenerates `specmarten/dashboard.html`; `--serve` for a local writable language bridge. |
| `archive <id>` | Native backend: move a change into the date-prefixed archive (default today; `--date YYYY-MM-DD` to override). |
| `closeout` | After archive: reconcile, render, refresh baseline, and validate in one step. |

The lifecycle group (`plan`, `backfill`, `maintain`, `check`, `promote`,
`new-stream`) and inspection group (`doctor`, `update`) round out the visible
commands. Advanced protocol commands (`context`, `state`, `render`, `reconcile`,
`baseline`, `patrol`) are available for skills, hooks, and automation but
hidden from `--help`.

## Typical Lifecycle

New native or existing OpenSpec project:

```sh
specmarten init
```

Plan or backfill with the AI skill, review the generated roadmap, then promote:

```sh
specmarten promote
```

Do change work through `$specmarten-run` or the selected backend. Native records
live under `specmarten/ledger/changes/`; OpenSpec records remain under
`openspec/changes/`. After a change is archived:

```sh
specmarten closeout
```

The native backend is file-oriented and AI-session managed. When accepting a
native change, first update the corresponding accepted documents under
`specmarten/ledger/specs/`, then archive and close out:

```sh
specmarten archive <change-id>
specmarten closeout
```

`specmarten archive <change-id>` moves the change directory into
`specmarten/ledger/changes/archive/<date>-<change-id>/` (date defaults to today,
override with `--date YYYY-MM-DD`). It performs the deterministic directory move
only; the semantic spec-accept step remains yours. OpenSpec projects continue to
use native OpenSpec apply/archive commands.

For the OpenSpec backend, if `closeout` reports a spec with `Purpose: TBD`, edit
the accepted spec purpose and run `specmarten closeout` again.

## New Direction

For a new product direction:

```sh
specmarten new-stream "Visualization"
```

This creates a reviewed draft for the next stream and marks the previous stream
as maintained. For truly concurrent work:

```sh
specmarten new-stream "Research track" --parallel
```

Review the generated roadmap/dashboard, then run:

```sh
specmarten promote
```

## Advanced

### Headless automation

Interactive usage is client-first and never auto-launches a model. For CI or
unattended automation you can opt into a local bring-your-own-agent CLI:

```sh
specmarten plan "build login" --headless
specmarten backfill --headless
specmarten maintain --headless
specmarten check add-login --headless
```

`SPECMARTEN_HEADLESS=1` enables the same mode for unattended environments.
Headless mode sends repository context to the configured local agent CLI
(`codex`, `claude`, or `gemini`) — use it only in trusted, isolated automation.
For untrusted pull requests, prefer the deterministic checks below. Claude support is Claude Code-only; Claude Desktop is not a supported integration target.

### CI drift gates

For SpecMarten's own repo, `.github/workflows/ci.yml` runs typecheck, build,
tests, and package checks. Projects that want a copyable drift gate can use:

- deterministic layer: `specmarten validate`
- optional semantic layer: `specmarten check <change> --headless`

`check --headless` exits `0` for PASS, `10` for WARN, and `2` for BLOCK.

## Configuration

`specmarten init` writes a project-level `.specmarten.json` containing the selected
`specBackend`. Projects can also set any preference explicitly:

```json
{
  "specBackend": "native",
  "agent": { "prefer": ["codex", "claude", "gemini"] },
  "dashboard": { "autoOpen": false },
  "language": { "content": "en" },
  "overseer": { "blocking": "advisory" }
}
```

Use `"openspec"` for repositories whose change ledger remains under `openspec/`.
One repository selects one backend; SpecMarten does not dual-write or synchronize
the two ledgers. `language.content` controls the language for future generated content. Existing
roadmap/task text is preserved.

### Global preferences

Shared user preferences can be placed in a global `config.json`. SpecMarten checks:

1. `SPECMARTEN_CONFIG` when it names an explicit file.
2. `$XDG_CONFIG_HOME/specmarten/config.json` when `XDG_CONFIG_HOME` is set.
3. `%APPDATA%/specmarten/config.json` on Windows.
4. `~/.config/specmarten/config.json` otherwise.

The global file is optional and can contain any preference except `specBackend`,
which always belongs to one project. For example:

```json
{
  "agent": { "prefer": ["codex", "claude"] },
  "dashboard": { "autoOpen": false },
  "language": { "content": "en" },
  "overseer": { "blocking": "advisory" }
}
```

Effective configuration is merged by field in this order: built-in defaults,
global preferences, then project configuration. Existing full project files remain
compatible; their explicit values continue to override the global file. Remove a
project preference when that project should inherit the corresponding global value.

## Guarantees

- Native projects do not require an `openspec/` directory or the OpenSpec CLI.
- Existing OpenSpec projects remain supported without changing their ledger layout.
- The configured backend is the only change-ledger authority for a repository.
- SpecMarten state lives in `specmarten/state.json`.
- Generated views are read-only outputs.
- Renderers never call an LLM.
- There is no `specmarten link` or manual task-linking command. (`specmarten archive` performs the native directory move; semantic spec-accept is still yours.)

## Examples

- `examples/native-sample/`: no-OpenSpec initialization and native lifecycle walkthrough.
- `examples/greenfield-sample/`: minimal OpenSpec project for the new-project flow.
- `examples/brownfield-sample/`: fake archived/active changes for backfill testing.
- [`docs/case-studies/private-investment-research/`](docs/case-studies/private-investment-research/): reviewed evidence export from a real unfinished private product.

For local development and release checks, run `npm test`, `npm run typecheck`,
and `npm pack --dry-run`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
