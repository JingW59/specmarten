import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL } from "../constants.js";
import { SPECMARTEN_CONTEXT_VERSION } from "../core/context/plan-context.js";
import {
  CODEX_GLOBAL_CONTEXT_CHECKPOINT,
  STREAM_AWARE_BACKFILL_GUIDANCE,
  STREAM_AWARE_ROADMAP_GUIDANCE
} from "../templates/shared-prompts.js";
import { ensureDir, pathExists, readText, writeText } from "../util/fs.js";

export const SPECMARTEN_PLAN_SKILL_NAME = "specmarten-plan";
export const SPECMARTEN_BACKFILL_SKILL_NAME = "specmarten-backfill";
export const SPECMARTEN_CHECK_SKILL_NAME = "specmarten-check";
export const SPECMARTEN_MAINTAIN_SKILL_NAME = "specmarten-maintain";
export const SPECMARTEN_STATUS_SKILL_NAME = "specmarten-status";
export const SPECMARTEN_RUN_SKILL_NAME = "specmarten-run";

export type CodexSkillAction = "created" | "updated" | "unchanged" | "preserved";

export interface CodexSkillFileResult {
  path: string;
  action: CodexSkillAction;
}

export interface CodexSkillInstallResult {
  codexHome: string;
  skillsDir: string;
  files: CodexSkillFileResult[];
}

export interface CodexSkillInstallOptions {
  overwrite?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const codexSkillTemplates: Record<string, string> = {
  [SPECMARTEN_RUN_SKILL_NAME]: renderSpecMartenRunSkill(),
  [SPECMARTEN_PLAN_SKILL_NAME]: renderSpecMartenPlanSkill(),
  [SPECMARTEN_BACKFILL_SKILL_NAME]: renderSpecMartenBackfillSkill(),
  [SPECMARTEN_CHECK_SKILL_NAME]: renderSpecMartenCheckSkill(),
  [SPECMARTEN_MAINTAIN_SKILL_NAME]: renderSpecMartenMaintainSkill(),
  [SPECMARTEN_STATUS_SKILL_NAME]: renderSpecMartenStatusSkill()
};

export async function installCodexSkills(options: CodexSkillInstallOptions = {}): Promise<CodexSkillInstallResult> {
  const codexHome = resolveCodexHome(options.env ?? process.env);
  const skillsDir = join(codexHome, "skills");

  const files: CodexSkillFileResult[] = [];
  for (const [name, content] of Object.entries(codexSkillTemplates)) {
    const skillDir = join(skillsDir, name);
    await ensureDir(skillDir);
    files.push(await writeSkillFile(join(skillDir, "SKILL.md"), content, Boolean(options.overwrite)));
  }

  return { codexHome, skillsDir, files };
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function renderSpecMartenPlanSkill(): string {
  return `---
name: specmarten-plan
description: Draft or refresh the global roadmap for a project that uses SpecMarten (+ OpenSpec). Use when the user wants to plan, scope, or generate a roadmap from a requirement inside a SpecMarten project. The current session generates the plan; the specmarten CLI only provides deterministic context, validation, and rendering.
---

# SpecMarten Plan

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project with both \`specmarten/\` and \`openspec/\`, and the user wants to turn a requirement into a global roadmap draft.

## Guardrails

- The current Codex session does the planning. Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- ${CODEX_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft\`.
- Never edit \`openspec/\`.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic context from the user's requirement:

\`\`\`sh
specmarten context --workflow plan --requirement "<user requirement>" --json
\`\`\`

Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

4. Use the envelope's \`instruction\`, \`globalDocs\`, current \`state\`, and \`outputSchema\` as the authority. Generate one JSON object matching \`outputSchema\`.

${STREAM_AWARE_ROADMAP_GUIDANCE}

\`status\` values may be omitted. If omitted, \`specmarten state write-draft --kind plan\` defaults phases to \`planned\` and tasks to \`todo\`.

5. Write the draft through the validation boundary:

\`\`\`sh
printf '%s' '<plan json>' | specmarten state write-draft --kind plan
\`\`\`

If this fails, read the structured stderr JSON, fix the plan JSON, and retry. Do not edit \`specmarten/state.json\` directly.

6. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

7. Report the draft summary, any questions, and any decisions the user must make. Tell the user to review \`specmarten/roadmap.md\` and promote with:

\`\`\`sh
specmarten promote
\`\`\`
`;
}

export function renderSpecMartenRunSkill(): string {
  return `---
name: specmarten-run
description: Take over one development task end-to-end in a SpecMarten + OpenSpec project. Use when the user wants the current AI session to create or update the OpenSpec change, implement the code, verify it, maintain SpecMarten state, render generated views, and report the result without asking the user to run each workflow step manually.
---

# SpecMarten Run

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project with both \`specmarten/\` and \`openspec/\`, and the user gives a development task they want the current AI session to handle end-to-end.

## Guardrails

- The current Codex session owns the full task. Do not stop after planning or hand the user a step list unless blocked.
- Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- ${CODEX_GLOBAL_CONTEXT_CHECKPOINT}
- Before implementing behavior changes, create or update a native OpenSpec change under \`openspec/changes/<change-id>/\` with \`proposal.md\`, \`tasks.md\`, and spec deltas.
- Do not edit accepted baseline specs under \`openspec/specs/\` directly except when applying or archiving an accepted OpenSpec change.
- \`specmarten/state.json\` is the only source of truth for the global layer. Model-produced maintenance output must only write through \`specmarten state write-draft --kind maintain\`.
- Do not manually edit \`specmarten/roadmap.md\` or \`specmarten/dashboard.html\`; render them from state.
- Do not commit, tag, publish, or push unless the user explicitly asks for that.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Validate the project and read the global checkpoint:

\`\`\`sh
specmarten validate
specmarten status --summary-json
\`\`\`

3. Interpret the user's task as the source of truth. If a missing detail would make implementation risky, ask one concise question; otherwise choose a small, repo-consistent change id.

4. Create or update \`openspec/changes/<change-id>/\` before touching behavior code:

- \`proposal.md\` explains why and what changes.
- \`tasks.md\` tracks implementation and verification.
- \`specs/<capability>/spec.md\` declares the behavioral delta.

5. Implement the smallest repo-consistent code change that satisfies the OpenSpec delta.

6. Run focused tests or checks for the changed behavior. Broaden verification only when the touched surface is shared.

7. Maintain SpecMarten state semantically:

\`\`\`sh
specmarten context --workflow maintain --json
\`\`\`

Use the envelope's \`reconcile.state\`, \`openSpec\`, and \`outputSchema\` as the authority. Link the active OpenSpec change to the relevant roadmap task, preserve existing streams/tracks/currentVersion, and write exactly one maintain JSON through:

\`\`\`sh
printf '%s' '<maintain json>' | specmarten state write-draft --kind maintain
\`\`\`

8. Repair generated views if needed and validate. If the task included a native OpenSpec archive, run \`specmarten closeout\` instead:

\`\`\`sh
specmarten validate --fix
specmarten validate
specmarten validate --complete
openspec validate --all --strict
# after archive only:
specmarten closeout
\`\`\`

9. Finish by reporting what changed, how it was verified, any remaining risk, and whether anything is intentionally left uncommitted.
`;
}

export function renderSpecMartenBackfillSkill(): string {
  return `---
name: specmarten-backfill
description: Draft a global SpecMarten roadmap from an existing OpenSpec project's active and archived changes. Use when the user wants to backfill or reconstruct global state in a SpecMarten project. The current session performs the semantic grouping; the specmarten CLI only provides deterministic context, validation, and rendering.
---

# SpecMarten Backfill

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project with both \`specmarten/\` and \`openspec/\`, and the user wants to reconstruct a global roadmap draft from existing OpenSpec changes.

## Guardrails

- The current Codex session does the semantic grouping. Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- ${CODEX_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft\`.
- Never edit \`openspec/\`.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic backfill context:

\`\`\`sh
specmarten context --workflow backfill --json
\`\`\`

Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

4. Use the envelope's \`instruction\`, \`globalDocs\`, \`openSpec\`, current \`state\`, and \`outputSchema\` as the authority. Generate one JSON object matching \`outputSchema\`.

${STREAM_AWARE_BACKFILL_GUIDANCE}

Group related active and archived OpenSpec changes into streams/tracks/phases and tasks. Put uncertain mappings in \`lowConfidence\` or \`unlinkedChanges\`; put replaced change ids in \`superseded\`. Task \`status\` and \`archivedAt\` are inferred by SpecMarten from the linked change ids, so only link change ids that genuinely belong to a task.

5. Write the draft through the validation boundary:

\`\`\`sh
printf '%s' '<backfill json>' | specmarten state write-draft --kind backfill
\`\`\`

If this fails, read the structured stderr JSON, fix the backfill JSON, and retry. Do not edit \`specmarten/state.json\` directly.

6. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

7. Report the draft summary, low-confidence items, superseded changes, and any decisions the user must make. Tell the user to review \`specmarten/roadmap.md\` and promote with:

\`\`\`sh
specmarten promote
\`\`\`
`;
}

export function renderSpecMartenCheckSkill(): string {
  return `---
name: specmarten-check
description: Run a client-first SpecMarten drift patrol for one OpenSpec change. Use when the user wants to check whether a change still aligns with the global mission, roadmap, standards, and baseline specs. The current session decides PASS/WARN/BLOCK; the specmarten CLI only provides deterministic context and report writing.
---

# SpecMarten Check

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project with both \`specmarten/\` and \`openspec/\`, and the user wants to patrol one OpenSpec change for drift.

## Guardrails

- The current Codex session does the drift judgment. Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- ${CODEX_GLOBAL_CONTEXT_CHECKPOINT}
- Write patrol results only through \`specmarten patrol report\`.
- Never edit \`openspec/\` or \`specmarten/state.json\` directly.
- WARN and BLOCK are advisory in the default mode; report them clearly even though \`specmarten patrol report\` exits non-zero for those verdicts.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic check context for the requested change id:

\`\`\`sh
specmarten context --workflow check --change "<change id>" --json
\`\`\`

Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

4. Use the envelope's \`instruction\`, \`globalDocs\`, \`state\`, \`openSpec.change\`, \`openSpec.baselineSpecs\`, \`triage\`, and \`outputSchema\` as the authority. Generate exactly one JSON object matching \`outputSchema\`:

\`\`\`json
{ "change": "<change id>", "report": "# Overseer report...\\nVERDICT: PASS|WARN|BLOCK\\n" }
\`\`\`

5. Write the report through the deterministic boundary:

\`\`\`sh
printf '%s' '<check json>' | specmarten patrol report
\`\`\`

Exit code 0 means PASS, 10 means WARN, and 2 means BLOCK. Treat all three as completed patrol outcomes, not as schema failures. If the command prints structured JSON to stderr, fix the check JSON and retry.

6. Report the verdict, the report path under \`specmarten/reports/\`, and the evidence behind the judgment.
`;
}

export function renderSpecMartenMaintainSkill(): string {
  return `---
name: specmarten-maintain
description: Synchronize the AI-maintained SpecMarten global state after OpenSpec changes or archives. Use when the user wants to refresh roadmap links, reconcile archived changes, and optionally run drift patrol from inside a SpecMarten project. The current session performs semantic maintenance; the specmarten CLI only provides deterministic context, validation, report writing, and rendering.
---

# SpecMarten Maintain

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project with both \`specmarten/\` and \`openspec/\`, especially after OpenSpec changes were added or archived.

## Guardrails

- The current Codex session does semantic maintenance. Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- ${CODEX_GLOBAL_CONTEXT_CHECKPOINT}
- \`specmarten/state.json\` is the only source of truth, and model output must only write through \`specmarten state write-draft --kind maintain\`.
- Write patrol results only through \`specmarten patrol report\`.
- Never edit \`openspec/\`.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Validate the project:

\`\`\`sh
specmarten validate
\`\`\`

If validation shows the project is not initialized, stop and tell the user to run \`specmarten init\`.

3. Build deterministic maintain context:

\`\`\`sh
specmarten context --workflow maintain --json
\`\`\`

Parse the JSON envelope. If \`specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\`, stop and tell the user to run \`specmarten update\`.

4. Use the envelope's \`instruction\`, \`globalDocs\`, \`state\`, \`reconcile\`, \`triage\`, \`openSpec\`, and \`outputSchema\` as the authority. Generate exactly one JSON object matching \`outputSchema\`.

- Start from \`reconcile.state\`; only change state fields that need semantic maintenance.
- Preserve existing \`streams\`, \`tracks\`, \`currentVersion\`, and \`supersedes\`; for a large new direction choose \`supersedes\` by default or \`parallel\` explicitly.
- Link OpenSpec changes semantically to roadmap tasks; do not rely on naming conventions.
- If \`triage.hit\` is true, include a \`patrol\` with a markdown report ending in \`VERDICT: PASS|WARN|BLOCK\`.
- If \`triage.hit\` is false, omit \`patrol\`.

5. If the maintain JSON contains \`patrol\`, write it first:

\`\`\`sh
printf '%s' '{"change":"<change id>","report":"<report>"}' | specmarten patrol report
\`\`\`

Exit code 0 means PASS, 10 means WARN, and 2 means BLOCK. Treat all three as completed advisory outcomes. If stderr is structured JSON, fix the patrol JSON and retry.

6. Write maintained state through the validation boundary:

\`\`\`sh
printf '%s' '<maintain json>' | specmarten state write-draft --kind maintain
\`\`\`

If this fails, read the structured stderr JSON, fix the maintain JSON, and retry. Do not edit \`specmarten/state.json\` directly.

7. Render generated views:

\`\`\`sh
specmarten render
\`\`\`

8. Report changed links, unlinked changes, patrol verdict/report path if any, and any follow-up decisions. No \`specmarten promote\` is needed for maintain.
`;
}

export function renderSpecMartenStatusSkill(): string {
  return `---
name: specmarten-status
description: Summarize the current SpecMarten global state for a project. Use when the user wants a plain-language status update for roadmap progress, in-progress changes, last patrol, WARN/BLOCK counts, and maintenance-needed signal.
---

# SpecMarten Status

<!-- SpecMarten skill version: ${TOOL.version}; context version: ${SPECMARTEN_CONTEXT_VERSION} -->

## When To Use

Use this when the current working directory is a SpecMarten project and the user asks for current status or progress.

## Guardrails

- Do not call \`codex exec\`, \`claude -p\`, \`gemini -p\`, or any other headless AI command.
- Do not edit files.
- Read status through the deterministic CLI output and summarize it for the user.
- Treat this skill as the read-only global context checkpoint for long-running sessions, including current stream, remaining tasks, and maintenance signals.

## Workflow

1. Guard the working directory before doing anything else:

\`\`\`sh
test -d specmarten && test -d openspec
\`\`\`

If either directory is missing, stop and tell the user to run \`specmarten init\` inside an OpenSpec project first.

2. Read the machine-readable status:

\`\`\`sh
specmarten status --summary-json
\`\`\`

3. Summarize the JSON in plain language:

- Current phase
- Progress
- In-progress changes
- Last patrol
- WARN/BLOCK report counts
- Whether no maintenance is needed, deterministic reconcile is needed, or semantic maintenance is needed

Do not run any other SpecMarten workflow unless the user asks for it.
`;
}

async function writeSkillFile(path: string, content: string, overwrite: boolean): Promise<CodexSkillFileResult> {
  if (!(await pathExists(path))) {
    await writeText(path, content);
    return { path, action: "created" };
  }

  const existing = await readText(path);
  if (existing === content) {
    return { path, action: "unchanged" };
  }

  if (!overwrite) {
    return { path, action: "preserved" };
  }

  await writeText(path, content);
  return { path, action: "updated" };
}
