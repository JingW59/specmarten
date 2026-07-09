# Contributing

Thanks for helping improve SpecMarten.

SpecMarten is an OpenSpec companion CLI. OpenSpec owns single-change workflows; SpecMarten owns the project-wide state, roadmap, dashboard, maintenance signal, and drift checks around those changes.

## Development Setup

```sh
npm ci
npm run build
npm test
```

Install OpenSpec before running repository-level validation:

```sh
npm install -g @fission-ai/openspec@1.5.0
for project in examples/*; do
  if [ -d "$project/openspec" ]; then
    (cd "$project" && openspec validate --all --strict)
  fi
done
```

## Before Sending A Change

Run the narrowest useful checks for your change. For release-facing changes, run the full gate:

```sh
npm audit
npm run typecheck
npm run build
npm test
openspec validate --all --strict
npm pack --dry-run
```

## OpenSpec Change Names

Use short, descriptive OpenSpec change ids without a date prefix, for example `fix-hard-contract-agentless-check`. Native OpenSpec archive already adds the archive date, so date-prefixed active change ids create noisy double-date archive paths.

## Design Boundaries

- Keep SpecMarten deterministic at file-write boundaries.
- Do not let model output write `specmarten/state.json` directly.
- Keep `specmarten/state.json` as the source of truth.
- Treat `specmarten/roadmap.md` and `specmarten/dashboard.html` as generated views.
- Do not add wrappers around native OpenSpec archive/apply/propose workflows unless the project explicitly changes that boundary.
- Keep integrations explicit: client-first by default, headless only by `--headless` or `SPECMARTEN_HEADLESS=1`.

## Pull Request Expectations

- Explain the user-facing behavior or release-readiness issue being changed.
- Link the relevant OpenSpec change when one exists.
- Include tests for CLI behavior, schema handling, generated output, or integration files when those surfaces change.
- Avoid unrelated refactors and formatting churn.
