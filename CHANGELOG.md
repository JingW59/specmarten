# Changelog

## 0.2.0 - 2026-07-12

### Added

- Added a native SpecMarten change-ledger backend under `specmarten/ledger/` so new projects can use roadmap, status, drift, baseline, and generated-view workflows without OpenSpec.
- Added backend-aware context envelopes with a neutral `ledger` field while preserving the existing `openSpec` field for compatibility.
- Added native-backend architecture, lifecycle, compatibility, verification, and example documentation.

### Changed

- New projects default to the native backend; repositories that already contain `openspec/` continue to select the OpenSpec backend automatically.
- CLI commands, generated Codex skills, Claude Code commands, validation messages, and generated views now follow the configured backend instead of assuming OpenSpec.
- Unconfigured backend detection now consistently prefers an existing OpenSpec project when both ledger layouts are present.
- Nested native and OpenSpec archive folders now retain the date from date-prefixed change directories.
- Native validation emits backend-neutral `change-*` machine codes; OpenSpec projects retain the historical `openspec-*` codes for compatibility.
- The context-envelope `openSpec` alias is deprecated in favor of `ledger` and retained through the `0.x` line.

## 0.1.2 - 2026-07-09

First public npm release of SpecMarten.

### Added

- Added the `specmarten` CLI for project-level OpenSpec roadmap, status, dashboard, drift-check, and maintenance workflows.
- Added client-first Codex skills and Claude Code commands for planning, backfill, maintenance, drift checks, status, and end-to-end task execution.
- Added deterministic commands for `status`, `next`, `maintain`, `reconcile`, `closeout`, `baseline refresh`, `validate --fix`, `validate --complete`, `dashboard`, and generated view rendering.
- Added `doctor` for CLI provenance in multi-checkout environments.
- Added `status --summary-json` for compact automation output without full diff payloads.
- Added OpenSpec consistency reporting for unlinked active and archived changes.
- Added Purpose TBD detection with concrete remediation hints before baseline refresh or closeout.
- Added copyable CI drift-gate examples and public project metadata, including MIT license, security policy, and CI.
- Added served dashboard preference writes through `dashboard --serve`.

### Changed

- Published the source tree through a clean-history public repository on 2026-07-09.
- Kept community contribution templates out of the initial public surface until the contribution process is defined.
- Dashboard output is self-contained, theme-aware, auto-refreshing, and supports Simplified Chinese for fixed UI text and supported state labels.
- Dashboard preference writes validate local same-origin requests, reject malformed client payloads with 400, and keep CSRF or origin failures at 403.
- Top-level CLI help now focuses on primary user commands while advanced protocol commands remain callable for skills, hooks, and automation.
- README content is shorter and centered on the primary AI-assisted and manual operating paths.
- `roadmap.md` renders stream and track structure so superseded and parallel roadmap lines stay visible.
- The default test suite runs without file-level parallelism to avoid process-global test races.
- Hand-written partial `.specmarten.json` files now fill object-level defaults consistently.
- NPM packaging builds before pack and CI asserts the packaged output includes the built CLI.
- Patrol reports use collision-resistant filenames so same-change reports are not overwritten.
- CLI stdout/stderr broken pipes are handled as normal shell pipeline termination.
- E2E tests isolate Codex skill writes from a developer's real `CODEX_HOME`.
- State writes use atomic JSON writes and a repo-local lock.
- Generated dashboard report links reject unsafe URLs, absolute paths, backslashes, and parent-directory traversal.
- Headless automation is explicit through `--headless` or `SPECMARTEN_HEADLESS=1`; the default interactive path is client-first and deterministic at file-write boundaries.
- This repository's local SpecMarten project state stays out of the public source tree.

### Breaking

- `specmarten plan`, `specmarten backfill`, `specmarten maintain`, and `specmarten check` no longer auto-launch a headless agent by default. Use `--headless` or `SPECMARTEN_HEADLESS=1` in unattended automation.
