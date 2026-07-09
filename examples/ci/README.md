# SpecMarten CI Drift Gate Examples

These files are copyable examples for other repositories. They are not active
CI for the SpecMarten repository; SpecMarten's own formal CI is handled separately.

## Two layers

Layer 1 is deterministic and requires zero secrets. It runs:

```sh
specmarten validate
specmarten reconcile
```

`specmarten validate` fails the gate when the project is invalid. `specmarten
reconcile` is informational in CI: it is deterministic, does not call an AI
agent, and exits 0.

Layer 2 is semantic and opt-in. Configure your own headless agent and set a CI
secret such as `AGENT_API_KEY`, then choose the OpenSpec change to patrol
with `SPECMARTEN_GATE_CHANGE`. The semantic layer runs:

```sh
specmarten check "$SPECMARTEN_GATE_CHANGE" --headless
```

## Exit codes

- `specmarten validate`: exits 0 when valid, non-zero when invalid.
- `specmarten reconcile`: exits 0.
- `specmarten check <change> --headless`: exits 0 for PASS, 10 for WARN, and 2
  for BLOCK.

The examples fail on BLOCK. WARN is advisory by default and does not fail the
gate; set `SPECMARTEN_GATE_STRICT_WARN=1` if your CI should fail on WARN.

## GitHub Actions

Copy `github-actions-drift-gate.yml` to your repository as
`.github/workflows/specmarten-drift-gate.yml`.

The deterministic job runs by default. The semantic job only runs its check
steps when both of these are configured:

- secret `AGENT_API_KEY`
- repository variable `SPECMARTEN_GATE_CHANGE`

Install your own agent CLI in the commented placeholder step if your headless
agent requires one. `AGENT_API_KEY` is only a placeholder for that agent; SpecMarten does not read it directly.

## Any CI system

Copy `drift-gate.sh` into your CI scripts and run it from the repository root:

```sh
sh path/to/drift-gate.sh
```

For deterministic-only gating, leave `SPECMARTEN_GATE_CHANGE` unset. For semantic
gating, set it to the OpenSpec change id before running the script:

```sh
SPECMARTEN_GATE_CHANGE=add-login sh path/to/drift-gate.sh
```

Set `SPECMARTEN_GATE_STRICT_WARN=1` when WARN should fail the job.
