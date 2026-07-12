import { SPECMARTEN_CONTEXT_VERSION } from "../core/context/plan-context.js";
import {
  CLAUDE_GLOBAL_CONTEXT_CHECKPOINT,
  STREAM_AWARE_BACKFILL_GUIDANCE,
  STREAM_AWARE_ROADMAP_GUIDANCE
} from "./shared-prompts.js";

export const templateFiles: Record<string, string> = {
  "mission.md": `# Mission

## Positioning
[TODO: describe what this project exists to do.]

## Problem
[TODO: describe the painful problem this project solves.]

## Target Users
[TODO: describe who this project serves.]

## Non-goals
[TODO: list important things this project should not do.]
`,
  "tech-stack.md": `# Tech Stack

## Core Dependencies
[TODO: list the core runtime, framework, database, and external service dependencies.]

## Global Sensitive Surfaces
[TODO: list architecture, model, API, CLI, data, and package surfaces that should trigger drift review.]
`,
  "standards/code-style.md": `# Code Style

- [TODO] Add project-specific style expectations the AI maintainer should preserve.
`,
  "standards/conventions.md": `# Conventions

- [TODO] Add naming, file layout, or workflow conventions the AI maintainer should preserve.
`,
  "standards/hard-rules.md": `# Hard Rules

- [HARD] Do not change public behavior already declared in accepted specs unless the active change declares it.
- [TODO] Add project-specific hard rules that should become BLOCK findings when violated.
`
};

export const claudeTemplateFiles: Record<string, string> = {
  "agents/maintainer.md": `# SpecMarten Maintainer

You are the SpecMarten maintenance AI for this repository.

Maintain specmarten/state.json as the only source of truth, semantically link configured-ledger changes to roadmap tasks, run drift review when asked, and never edit the configured ledger during maintenance.

Before long-running work or deep work on one change, run \`specmarten status --summary-json\` and keep current stream, remaining tasks, and maintenance signals in view as read-only context. If the next step is unclear, run \`specmarten next\`.
`,
  "agents/overseer.md": `# SpecMarten Overseer

You are an independent global consistency auditor. Read specmarten/mission.md, specmarten/tech-stack.md, specmarten/standards/, specmarten/baseline/, current accepted specs, and the active change before judging drift.

Only objectively falsifiable violations should be BLOCK. Judgment calls should be WARN. Report only; do not edit code.
`,
  "commands/sm-plan.md": `# SpecMarten Plan

Use this command to draft or refresh the global roadmap from a requirement.

## Guardrails

- The current Claude Code session does the planning. Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- ${CLAUDE_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft\`.
- Never edit the configured change ledger during roadmap planning.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Use \`$ARGUMENTS\` as the requirement. If \`$ARGUMENTS\` is empty, ask the user for the requirement before continuing. Then build deterministic context:

\`\`\`sh
specmarten context --workflow plan --requirement "$ARGUMENTS" --json
\`\`\`

4. Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

5. Use the envelope's \`instruction\`, \`globalDocs\`, current \`state\`, and \`outputSchema\` as the authority. Generate one JSON object matching \`outputSchema\`.

${STREAM_AWARE_ROADMAP_GUIDANCE}

6. Write the draft through the validation boundary:

\`\`\`sh
printf '%s' '<plan json>' | specmarten state write-draft --kind plan
\`\`\`

If this fails, read the structured stderr JSON, fix the plan JSON, and retry. Do not edit \`specmarten/state.json\` directly.

7. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

8. Report the draft summary, any questions, and any decisions the user must make. Tell the user to review \`specmarten/roadmap.md\` and promote with:

\`\`\`sh
specmarten promote
\`\`\`
`,
  "commands/sm-run.md": `# SpecMarten Run

Use this command to take over one development task end-to-end.

## Guardrails

- The current Claude Code session owns the full task. Do not stop after planning or hand the user a step list unless blocked.
- Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- ${CLAUDE_GLOBAL_CONTEXT_CHECKPOINT}
- Before implementing behavior changes, read \`specBackend\` from \`.specmarten.json\`. Create or update the change under \`openspec/changes/<change-id>/\` for the OpenSpec backend or \`specmarten/ledger/changes/<change-id>/\` for the native backend, with \`proposal.md\`, \`tasks.md\`, and spec deltas.
- Do not edit accepted baseline specs directly except when applying or archiving an accepted change.
- \`specmarten/state.json\` is the only source of truth for the global layer. Model-produced maintenance output must only write through \`specmarten state write-draft --kind maintain\`.
- Do not manually edit \`specmarten/roadmap.md\` or \`specmarten/dashboard.html\`; render them from state.
- Do not commit, tag, publish, or push unless the user explicitly asks for that.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project and read the global checkpoint:

\`\`\`sh
specmarten validate
specmarten status --summary-json
\`\`\`

3. Use \`$ARGUMENTS\` as the task. If \`$ARGUMENTS\` is empty, ask the user for the task before continuing. If a missing detail would make implementation risky, ask one concise question; otherwise choose a small, repo-consistent change id.

4. Create or update the configured backend's change directory before touching behavior code:

- OpenSpec backend: \`openspec/changes/<change-id>/\`
- Native backend: \`specmarten/ledger/changes/<change-id>/\`

- \`proposal.md\` explains why and what changes.
- \`tasks.md\` tracks implementation and verification.
- \`specs/<capability>/spec.md\` declares the behavioral delta.

5. Implement the smallest repo-consistent code change that satisfies the declared delta.

6. Run focused tests or checks for the changed behavior. Broaden verification only when the touched surface is shared.

If the change is accepted and should be archived in this task:

- OpenSpec backend: use the native OpenSpec apply/archive workflow.
- Native backend: semantically update accepted specs under \`specmarten/ledger/specs/\`, then move the completed change to \`specmarten/ledger/changes/archive/<date>-<change-id>/\`.

7. Maintain SpecMarten state semantically:

\`\`\`sh
specmarten context --workflow maintain --json
\`\`\`

Use the envelope's \`reconcile.state\`, \`ledger\`, and \`outputSchema\` as the authority. Link the active change to the relevant roadmap task, preserve existing streams/tracks/currentVersion, and write exactly one maintain JSON through:

\`\`\`sh
printf '%s' '<maintain json>' | specmarten state write-draft --kind maintain
\`\`\`

8. Repair generated views if needed and validate. Run OpenSpec validation only for the OpenSpec backend. After any archive, run \`specmarten closeout\`:

\`\`\`sh
specmarten validate --fix
specmarten validate
specmarten validate --complete
# OpenSpec backend only: openspec validate --all --strict
# after any archive:
specmarten closeout
\`\`\`

9. Finish by reporting what changed, how it was verified, any remaining risk, and whether anything is intentionally left uncommitted.
`,
  "commands/sm-backfill.md": `# SpecMarten Backfill

Use this command to draft a global SpecMarten roadmap from existing configured-ledger changes.

## Guardrails

- The current Claude Code session does the semantic grouping. Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- ${CLAUDE_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft\`.
- Never edit the configured change ledger during backfill.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic backfill context:

\`\`\`sh
specmarten context --workflow backfill --json
\`\`\`

4. Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

5. Use the envelope's \`instruction\`, \`globalDocs\`, \`ledger\`, current \`state\`, and \`outputSchema\` as the authority. Generate one JSON object matching \`outputSchema\`.

${STREAM_AWARE_BACKFILL_GUIDANCE}

Group related active and archived changes into streams/tracks/phases and tasks. Put uncertain mappings in \`lowConfidence\` or \`unlinkedChanges\`; put replaced change ids in \`superseded\`. Task \`status\` and \`archivedAt\` are inferred by SpecMarten from the linked change ids, so only link change ids that genuinely belong to a task.

6. Write the draft through the validation boundary:

\`\`\`sh
printf '%s' '<backfill json>' | specmarten state write-draft --kind backfill
\`\`\`

If this fails, read the structured stderr JSON, fix the backfill JSON, and retry. Do not edit \`specmarten/state.json\` directly.

7. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

8. Report the draft summary, low-confidence items, superseded changes, and any decisions the user must make. Tell the user to review \`specmarten/roadmap.md\` and promote with:

\`\`\`sh
specmarten promote
\`\`\`
`,
  "commands/sm-check.md": `# SpecMarten Check

Use this command to run a client-first drift patrol for one configured-ledger change.

## Guardrails

- The current Claude Code session does the drift judgment. Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- ${CLAUDE_GLOBAL_CONTEXT_CHECKPOINT}
- Write patrol results only through \`specmarten patrol report\`.
- Never edit the configured change ledger or \`specmarten/state.json\` directly.
- WARN and BLOCK are advisory in the default mode; report them clearly even though \`specmarten patrol report\` exits non-zero for those verdicts.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Use \`$ARGUMENTS\` as the change id. If \`$ARGUMENTS\` is empty, ask the user for the change id before continuing. Then build deterministic check context:

\`\`\`sh
specmarten context --workflow check --change "$ARGUMENTS" --json
\`\`\`

4. Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

5. Use the envelope's \`instruction\`, \`globalDocs\`, \`state\`, \`ledger.change\`, \`ledger.baselineSpecs\`, \`triage\`, and \`outputSchema\` as the authority. Generate exactly one JSON object matching \`outputSchema\`:

\`\`\`json
{ "change": "<change id>", "report": "# Overseer report...\\nVERDICT: PASS|WARN|BLOCK\\n" }
\`\`\`

6. Write the report through the deterministic boundary:

\`\`\`sh
printf '%s' '<check json>' | specmarten patrol report
\`\`\`

Exit code 0 means PASS, 10 means WARN, and 2 means BLOCK. Treat all three as completed patrol outcomes, not as schema failures. If the command prints structured JSON to stderr, fix the check JSON and retry.

7. Report the verdict, the report path under \`specmarten/reports/\`, and the evidence behind the judgment.
`,
  "commands/sm-maintain.md": `# SpecMarten Maintain

Use this command to synchronize global SpecMarten state after configured-ledger changes or archives.

## Guardrails

- The current Claude Code session does semantic maintenance. Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- ${CLAUDE_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft --kind maintain\`.
- Write patrol results only through \`specmarten patrol report\`.
- Never edit the configured change ledger during maintenance.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic maintain context:

\`\`\`sh
specmarten context --workflow maintain --json
\`\`\`

4. Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

5. Use the envelope's \`instruction\`, \`globalDocs\`, \`state\`, \`reconcile\`, \`triage\`, \`ledger\`, and \`outputSchema\` as the authority. Generate exactly one JSON object matching \`outputSchema\`.

- Start from \`reconcile.state\`; only change state fields that need semantic maintenance.
- Preserve existing \`streams\`, \`tracks\`, \`currentVersion\`, and \`supersedes\`; for a large new direction choose \`supersedes\` by default or \`parallel\` explicitly.
- Link changes semantically to roadmap tasks; do not rely on naming conventions.
- If \`triage.hit\` is true, include a \`patrol\` with a markdown report ending in \`VERDICT: PASS|WARN|BLOCK\`.
- If \`triage.hit\` is false, omit \`patrol\`.

6. If the maintain JSON contains \`patrol\`, write it first:

\`\`\`sh
printf '%s' '{"change":"<change id>","report":"<report>"}' | specmarten patrol report
\`\`\`

Exit code 0 means PASS, 10 means WARN, and 2 means BLOCK. Treat all three as completed advisory outcomes. If stderr is structured JSON, fix the patrol JSON and retry.

7. Write maintained state through the validation boundary:

\`\`\`sh
printf '%s' '<maintain json>' | specmarten state write-draft --kind maintain
\`\`\`

If this fails, read the structured stderr JSON, fix the maintain JSON, and retry. Do not edit \`specmarten/state.json\` directly.

8. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

9. Report changed links, unlinked changes, patrol verdict/report path if any, and any follow-up decisions. No \`specmarten promote\` is needed for maintain.
`,
  "commands/sm-status.md": `# SpecMarten Status

Use this command to summarize the current SpecMarten global state.

## Guardrails

- Do not call \`claude -p\`, \`codex exec\`, \`gemini -p\`, or any other headless AI command.
- Do not edit files.
- Read status through the deterministic CLI output and summarize it for the user.
- Treat this command as the read-only global context checkpoint for long-running sessions, including current stream, remaining tasks, and maintenance signals.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -f .specmarten.json
\`\`\`

If either path is missing, stop and tell the user to run \`specmarten init\` first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Read the machine-readable status:

\`\`\`sh
specmarten status --summary-json
\`\`\`

4. Summarize the JSON in plain language:

- Current phase
- Progress
- In-progress changes
- Last patrol
- WARN/BLOCK report counts
- Whether no maintenance is needed, deterministic reconcile is needed, or semantic maintenance is needed

Do not run any other SpecMarten workflow unless the user asks for it.
`,
  "specmarten-posttooluse-hook.example.json": `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "specmarten reconcile"
          }
        ]
      }
    ]
  }
}
`
};

export const claudeSettingsTemplate = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command:
              "case \"$CLAUDE_TOOL_INPUT\" in *openspec*|*specmarten/ledger/*) specmarten reconcile >/dev/null 2>&1 || true ;; esac"
          }
        ]
      }
    ]
  }
};
