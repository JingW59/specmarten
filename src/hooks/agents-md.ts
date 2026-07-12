import { join } from "node:path";
import { pathExists, readText, writeText } from "../util/fs.js";

const START = "<!-- BEGIN SPECMARTEN MANAGED BLOCK -->";
const END = "<!-- END SPECMARTEN MANAGED BLOCK -->";

const BLOCK = `${START}
## SpecMarten Maintenance

- After every configured-ledger archive or change, use \`$specmarten-maintain\` for semantic maintenance.
- After archiving any change, run \`specmarten closeout\` to reconcile, render, refresh the accepted baseline, and validate.
- Before implementing behavior changes, read \`specBackend\` from \`.specmarten.json\`. Use \`openspec/changes/<change-id>/\` for the OpenSpec backend or \`specmarten/ledger/changes/<change-id>/\` for the native backend; do not edit accepted specs directly except when applying or archiving an accepted change.
- To start or refresh the global roadmap in Codex, use \`$specmarten-plan\`.
- When unsure what comes next, run \`specmarten next\` and follow the printed command.
- Before deep work on one change or after a long session, run \`specmarten status --summary-json\` or \`$specmarten-status\` to keep current stream, remaining tasks, and maintenance signals in view. Treat this as read-only context.
- Do not manually edit \`specmarten/roadmap.md\` or \`specmarten/dashboard.html\`; they are generated from \`specmarten/state.json\`.
${END}`;

export interface AgentsMdInstallResult {
  path: string;
  action: "created" | "updated" | "unchanged";
}

export async function installAgentsMdGuidance(root: string): Promise<AgentsMdInstallResult> {
  const path = join(root, "AGENTS.md");
  const existing = (await pathExists(path)) ? await readText(path) : "";
  const next = upsertManagedBlock(existing);

  if (next === existing) {
    return { path, action: "unchanged" };
  }

  await writeText(path, next);
  return { path, action: existing ? "updated" : "created" };
}

function upsertManagedBlock(existing: string): string {
  const pattern = new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`);
  if (pattern.test(existing)) {
    return existing.replace(pattern, BLOCK);
  }

  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${BLOCK}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
