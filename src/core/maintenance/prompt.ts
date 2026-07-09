import type { ChangeDetail, SpecMeta } from "../../adapters/spec-backend/types.js";
import {
  DEFAULT_CONTENT_LANGUAGE,
  contentLanguageInstruction,
  type ContentLanguage
} from "../content-language.js";
import type { TriageResult } from "../overseer/triage.js";
import type { SpecMartenState } from "../state/schema.js";
import { maintainOutputSchema } from "./schema.js";

export interface MaintainPromptInput {
  state: SpecMartenState;
  contentLanguage: ContentLanguage;
  changes: ChangeDetail[];
  specs: SpecMeta[];
  triage: TriageResult;
}

export function maintainInstruction(contentLanguage: ContentLanguage = DEFAULT_CONTENT_LANGUAGE): string {
  return `You are the SpecMarten maintenance AI.

Responsibilities:
- Maintain specmarten/state.json as the single source of truth.
- Semantically reconcile OpenSpec changes to roadmap tasks.
- Preserve existing streams, tracks, currentVersion, and supersedes relationships unless semantic maintenance requires a change.
- Link unlinked active changes to the roadmap task that represents the work in progress; link unlinked archived changes to the task they completed.
- When a newly active or archived OpenSpec change represents a large new direction, surface the stream decision explicitly: use supersedes by default for the next milestone, and use parallel only for genuinely concurrent work.
- Use reconcile.suggestedLinks as hints, but verify semantically before changing task links.
- Do not rely on naming conventions and do not ask humans to link changes manually.
- If triage.hit is true, include a patrol report in the required format.
- Never edit openspec/.
- Return JSON only, matching the provided output schema.
${contentLanguageInstruction(contentLanguage)}

If triage.hit is false, omit "patrol".`;
}

export function buildMaintainPrompt(input: MaintainPromptInput): string {
  return `${maintainInstruction(input.contentLanguage)}

Output schema:
${JSON.stringify(maintainOutputSchema(), null, 2)}

Current state.json:
${JSON.stringify(input.state, null, 2)}

OpenSpec specs:
${JSON.stringify(input.specs, null, 2)}

OpenSpec changes:
${JSON.stringify(input.changes.map(serializeChange), null, 2)}

Triage:
${JSON.stringify(input.triage, null, 2)}
`;
}

function serializeChange(change: ChangeDetail): object {
  return {
    id: change.id,
    status: change.status,
    title: change.title,
    archivedAt: change.archivedAt,
    specsTouched: change.specsTouched,
    proposal: change.proposal,
    tasks: change.tasks,
    specDeltas: change.specDeltas.map((delta) => ({
      path: delta.path,
      contentPreview: delta.content.slice(0, 4000)
    }))
  };
}
