import type { ChangeDetail, SpecBackend } from "../../adapters/spec-backend/types.js";
import { readText } from "../../util/fs.js";

export interface PurposeTbdIssue {
  specId: string;
  path: string;
  suggestedPurpose?: string;
  fixCommand: string;
}

export async function findPurposeTbdIssues(backend: SpecBackend): Promise<PurposeTbdIssue[]> {
  const [specs, activeChanges, archivedChanges] = await Promise.all([
    backend.listSpecs(),
    backend.listActiveChanges(),
    backend.listArchivedChanges()
  ]);
  const changes = [...activeChanges, ...archivedChanges];
  const output: PurposeTbdIssue[] = [];

  for (const spec of specs.filter((item) => item.path.endsWith("spec.md"))) {
    const content = await readText(spec.path);
    const purpose = content.match(/^## Purpose\s*([\s\S]*?)(?=^##\s|\s*$)/m)?.[1] ?? "";
    if (!/\bTBD\b/i.test(purpose.trim())) {
      continue;
    }

    const specRoot = spec.id.replace(/\/spec\.md$/, "");
    const related = changes.filter((change) => change.specsTouched.includes(specRoot));
    const details = await Promise.all(related.map((change) => backend.readChange(change.id)));

    output.push({
      specId: spec.id,
      path: spec.path,
      suggestedPurpose: inferPurpose(details),
      fixCommand: `edit ${spec.path}`
    });
  }

  return output;
}

export function formatPurposeTbdIssue(issue: PurposeTbdIssue): string {
  const suggestion = issue.suggestedPurpose ? ` Suggested Purpose: "${issue.suggestedPurpose}"` : "";
  return `OpenSpec spec ${issue.specId} still has Purpose TBD. Edit ${issue.path} before accepting the baseline.${suggestion}`;
}

function inferPurpose(changes: ChangeDetail[]): string | undefined {
  for (const change of changes) {
    const fromProposal = firstUsefulProposalLine(change.proposal);
    if (fromProposal) {
      return ensureSentence(fromProposal);
    }
  }

  for (const change of changes) {
    const fromDelta = firstRequirementPurpose(change);
    if (fromDelta) {
      return ensureSentence(fromDelta);
    }
  }

  for (const change of changes) {
    if (change.title) {
      return ensureSentence(`Define ${change.title} behavior`);
    }
  }

  return undefined;
}

function firstUsefulProposalLine(markdown?: string): string | undefined {
  if (!markdown) {
    return undefined;
  }

  const why = markdown.match(/^## Why\s*([\s\S]*?)(?=^##\s|\s*$)/m)?.[1] ?? markdown;
  return why
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .find((line) => line.length > 0 && !line.startsWith("#"));
}

function firstRequirementPurpose(change: ChangeDetail): string | undefined {
  for (const delta of change.specDeltas) {
    const requirement = delta.content.match(/^### Requirement:\s*(.+)$/m)?.[1]?.trim();
    if (requirement) {
      return `Define ${requirement} behavior`;
    }
  }

  return undefined;
}

function ensureSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 180);
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}
