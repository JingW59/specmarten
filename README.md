# SpecMarten

SpecMarten is a small project-level companion for OpenSpec. OpenSpec still owns
single-change work (`propose`, `apply`, `archive`). SpecMarten keeps the shared
project layer around those changes:

- roadmap and current direction
- task progress linked to OpenSpec changes
- generated `specmarten/roadmap.md` and `specmarten/dashboard.html`
- drift/check context for AI-assisted coding sessions
- a short "what should I do next?" command

SpecMarten is client-first by default: the current AI session does the semantic
work, while the CLI provides deterministic context, validation, state writes, and
generated views.

SpecMarten is independent companion tooling. It is not affiliated with,
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

In a repository that already has `openspec/`:

```sh
specmarten init
```

If the repository does not have OpenSpec yet:

```sh
specmarten init --bootstrap
```

For smoke tests or repos where you do not want Codex, Claude Code, or git hook
files installed yet:

```sh
specmarten init --bootstrap --minimal
```

`init` creates the SpecMarten layer, renders the first views, writes
`.specmarten.json`, and installs supported AI-session files when the matching
tool is detected. Use `--no-codex`, `--no-claude`, or `--minimal` to skip those
integrations.

## Main AI Path

Use the installed skills from Codex:

```text
$specmarten-run add the next feature or fix
$specmarten-plan describe the product or next milestone
$specmarten-backfill
$specmarten-maintain
$specmarten-check <change-id>
$specmarten-status
```

`$specmarten-run` is the end-to-end path: it creates or updates the OpenSpec
change, implements the code, runs verification, refreshes SpecMarten state,
renders views, and reports the result. It does not commit, tag, publish, or push
unless you explicitly ask for that.

## Manual Path

When operating by hand, start here:

```sh
specmarten next
specmarten status
specmarten doctor
specmarten dashboard
specmarten closeout
specmarten maintain
specmarten check <change-id>
specmarten validate
specmarten validate --fix
specmarten validate --complete
```

The shortest rule is: run `specmarten next` and follow the one command it prints.

Common meanings:

| Command | Purpose |
| --- | --- |
| `next` | Prints the next recommended action for the current OpenSpec/SpecMarten state. |
| `status` | Read-only progress, drift, and maintenance snapshot. Use `--summary-json` for compact automation output without full diffs. |
| `doctor` | Read-only CLI provenance: version, commit, package path, remote, and build time. |
| `dashboard` | Regenerates `specmarten/dashboard.html`; use `dashboard --serve` for a local writable language preference bridge. |
| `closeout` | After OpenSpec archive: reconcile, render, refresh baseline, and validate. |
| `maintain` | Deterministic reconcile and render; use the skill or `--headless` for semantic maintenance. |
| `check <change>` | Builds check context; `--headless` can run the local agent path for automation. |
| `validate` | Validates state, generated views, config, available agents, and baseline. |
| `validate --fix` | Regenerates stale generated views, then validates again. JSON output reports `viewsFixed`, reserved `stateFixed`, and remaining issues. |
| `validate --complete` | Completion gate: fails if active OpenSpec checklists are unfinished or SpecMarten state still needs reconciliation. |

Advanced protocol commands such as `context`, `state`, `render`, `reconcile`,
`baseline`, and `patrol` are still available for skills, hooks, and automation,
but they are intentionally hidden from the top-level help.

## Typical Lifecycle

New or existing OpenSpec project:

```sh
specmarten init
```

Plan or backfill with the AI skill, review the generated roadmap, then promote:

```sh
specmarten promote
```

Do change work with native OpenSpec. After a change is archived:

```sh
specmarten closeout
```

If `closeout` reports an OpenSpec spec with `Purpose: TBD`, edit the accepted
spec purpose and run `specmarten closeout` again.

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

## Headless Automation

Interactive usage is client-first and does not auto-launch a model. Automation
can opt into a local bring-your-own-agent CLI:

```sh
specmarten plan "build login" --headless
specmarten backfill --headless
specmarten maintain --headless
specmarten check add-login --headless
```

`SPECMARTEN_HEADLESS=1` enables the same mode for unattended environments.

Headless mode sends repository context to the configured local agent CLI
(`codex`, `claude`, or `gemini`). Use it only in trusted, isolated automation.
For untrusted pull requests, prefer deterministic checks.

Claude support is Claude Code-only. Claude Desktop is not a supported integration target.

## CI

For SpecMarten's own repo, `.github/workflows/ci.yml` runs typecheck, build,
tests, OpenSpec validation, and package checks.

For projects that want a copyable drift gate, see `examples/ci/` in this
repository or npm package:

- deterministic layer: `specmarten validate`
- optional semantic layer: `specmarten check <change> --headless`

`check --headless` exits `0` for PASS, `10` for WARN, and `2` for BLOCK.

## Configuration

`specmarten init` writes `.specmarten.json`. The most commonly changed fields are:

```json
{
  "specBackend": "openspec",
  "agent": { "prefer": ["codex", "claude", "gemini"] },
  "dashboard": { "autoOpen": false },
  "language": { "content": "en" },
  "overseer": { "blocking": "advisory" }
}
```

`language.content` controls the language for future generated content. Existing
roadmap/task text is preserved.

## Guarantees

- SpecMarten does not replace OpenSpec.
- OpenSpec owns `propose`, `apply`, and `archive`.
- SpecMarten state lives in `specmarten/state.json`.
- Generated views are read-only outputs.
- Renderers never call an LLM.
- There is no `specmarten archive`, `specmarten link`, or manual task-linking command.

## Examples

- `examples/greenfield-sample/`: minimal OpenSpec project for the new-project flow.
- `examples/brownfield-sample/`: fake archived/active changes for backfill testing.
- [`docs/case-studies/private-investment-research/`](docs/case-studies/private-investment-research/): reviewed evidence export from a real unfinished private product.

For local development and release checks, run `npm test`, `npm run typecheck`,
and `npm pack --dry-run`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
