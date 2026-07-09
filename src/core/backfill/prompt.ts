import type { ChangeDetail, ChangeMeta, SpecMeta } from "../../adapters/spec-backend/types.js";
import {
  DEFAULT_CONTENT_LANGUAGE,
  contentLanguageInstruction,
  type ContentLanguage
} from "../content-language.js";
import { backfillOutputSchema } from "./schema.js";

export interface BackfillPromptInput {
  groupBy: "capability" | "time" | "flat";
  contentLanguage: ContentLanguage;
  changes: ChangeDetail[];
  specs: SpecMeta[];
}

export type SerializedBackfillChange = ChangeMeta & {
  proposal?: string;
  tasks?: string;
  specDeltas: Array<{ path: string; contentPreview: string }>;
};

export function backfillInstruction(
  input: Pick<BackfillPromptInput, "groupBy"> & { contentLanguage?: ContentLanguage }
): string {
  const contentLanguage = input.contentLanguage ?? DEFAULT_CONTENT_LANGUAGE;
  return `You are the SpecMarten backfill maintainer.

Goal: reconstruct an AI-maintained global roadmap draft from an existing OpenSpec project.

Rules:
- Prefer a stream-aware roadmap: emit currentVersion + streams[] (each stream carries direct phases or parallel tracks) so versioned lines and concurrent work are preserved.
- When history shows a large new direction, surface the stream decision explicitly: use supersedes by default when the new stream becomes the next milestone, and use parallel only when the work is genuinely concurrent with the current stream.
- Use "label" for stream and track display names. Use "title" only for phases and tasks.
- Legacy flat phases[] output is still accepted and wraps into a single active stream; use it only for a simple single-version history.
- Do not invent naming conventions or manual links.
- Use semantic understanding of proposals, tasks, and spec deltas.
- Archived changes become completed work. Active changes become in-progress work. Task status and archivedAt are inferred by SpecMarten from the linked change ids you provide, so only link change ids that genuinely belong to a task.
- Group phases by: ${input.groupBy}.
- If a change cannot be confidently mapped, include it in unlinkedChanges or lowConfidence.
- Replaced/obsolete changes go in superseded; SpecMarten excludes them from links.
- Keep state.json as the only source of truth; roadmap.md is a generated view.
- Return JSON only, matching the provided output schema.
${contentLanguageInstruction(contentLanguage)}`;
}

export function buildBackfillPrompt(input: BackfillPromptInput): string {
  return `${backfillInstruction({ groupBy: input.groupBy, contentLanguage: input.contentLanguage })}

Output schema:
${JSON.stringify(backfillOutputSchema(), null, 2)}

Example stream-aware response:
{
  "mission": "short project summary if inferable, otherwise empty",
  "currentVersion": "v2",
  "streams": [
    {
      "id": "v1",
      "version": "v1",
      "label": "v1",
      "state": "maintained",
      "phases": [
        { "title": "Shipped MVP", "tasks": [ { "title": "Login", "changes": ["2026-06-01-add-login"] } ] }
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
          "label": "Status track",
          "phases": [
            { "title": "Status command", "tasks": [ { "title": "Add status command", "changes": ["add-status-command"] } ] }
          ]
        }
      ]
    }
  ],
  "unlinkedChanges": [],
  "lowConfidence": [],
  "superseded": [],
  "notes": []
}

Legacy single-phase response (still accepted):
{
  "mission": "short project summary if inferable, otherwise empty",
  "phases": [
    {
      "id": "optional stable id",
      "title": "phase title",
      "tasks": [
        { "id": "optional task id", "title": "task title", "changes": ["change-id"], "source": "optional" }
      ]
    }
  ],
  "unlinkedChanges": [],
  "lowConfidence": [],
  "superseded": [],
  "notes": []
}

OpenSpec specs:
${JSON.stringify(input.specs, null, 2)}

Changes:
${JSON.stringify(input.changes.map(serializeBackfillChange), null, 2)}
`;
}

export function serializeBackfillChange(change: ChangeDetail): SerializedBackfillChange {
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
