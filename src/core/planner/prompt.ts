import type { SpecMartenState } from "../state/schema.js";
import {
  DEFAULT_CONTENT_LANGUAGE,
  contentLanguageInstruction,
  type ContentLanguage
} from "../content-language.js";
import { planOutputSchema } from "./schema.js";

export { planOutputSchema } from "./schema.js";

export interface PlanPromptInput {
  requirement: string;
  state: SpecMartenState;
  contentLanguage: ContentLanguage;
  missionDoc: string;
  techStackDoc: string;
  standardsDocs: Array<{ path: string; content: string }>;
}

export function planInstruction(contentLanguage: ContentLanguage = DEFAULT_CONTENT_LANGUAGE): string {
  return `You are the SpecMarten planner AI.

Goal: turn the user's natural-language requirement into a roadmap draft in specmarten/state.json.

Rules:
- Return a DRAFT only. Human review is required before promotion.
- Prefer a stream-aware roadmap: emit currentVersion + streams[]. Each stream is a versioned line (id/version/label/state) that may supersede an older stream and carry either phases[] or parallel tracks[] of phases.
- When the requirement is a large new direction, surface the stream decision explicitly: use supersedes by default when the new stream becomes the next milestone, and use parallel only when the work is genuinely concurrent with the current stream.
- Legacy flat phases[] output is still accepted and wraps into a single active stream; use it only for a simple single-version roadmap.
- Do not make product decisions that belong to the user. Preserve [TODO] placeholders when the global docs require user input.
- Do not invent OpenSpec change ids. This is planning; changes[] should usually be empty.
- Keep state.json as the only source of truth; roadmap.md is a generated view.
- Return JSON only, matching the provided output schema.
${contentLanguageInstruction(contentLanguage)}`;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  return `${planInstruction(input.contentLanguage)}

Output schema:
${JSON.stringify(planOutputSchema(), null, 2)}

Example stream-aware response:
{
  "mission": "short mission summary, or keep existing/empty if unclear",
  "currentVersion": "v2",
  "streams": [
    {
      "id": "v1",
      "version": "v1",
      "label": "v1",
      "state": "maintained",
      "phases": [
        { "id": "v1-p1", "title": "Shipped MVP", "status": "done", "tasks": [] }
      ]
    },
    {
      "id": "v2",
      "version": "v2",
      "label": "v2",
      "state": "active",
      "supersedes": "v1",
      "tracks": [
        {
          "id": "v2-api",
          "label": "API track",
          "phases": [
            { "id": "v2-api-p1", "title": "New API", "status": "planned", "tasks": [
              { "id": "v2-api-p1.1", "title": "Task title", "status": "todo", "changes": [] }
            ] }
          ]
        }
      ]
    }
  ],
  "questions": ["decisions the user must make"],
  "notes": []
}

Legacy single-phase response (still accepted):
{
  "mission": "short mission summary, or keep existing/empty if unclear",
  "phases": [
    { "id": "p1", "title": "MVP", "status": "planned", "tasks": [
      { "id": "p1.1", "title": "Task title", "status": "todo", "changes": [] }
    ] }
  ],
  "questions": [],
  "notes": []
}

User requirement:
${input.requirement}

Existing state:
${JSON.stringify(input.state, null, 2)}

mission.md:
${input.missionDoc}

tech-stack.md:
${input.techStackDoc}

standards:
${JSON.stringify(input.standardsDocs, null, 2)}
`;
}
