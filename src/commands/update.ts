import { Command } from "commander";
import { TOOL } from "../constants.js";
import { installCodexSkills, type CodexSkillInstallResult } from "../hooks/codex-skills.js";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Refresh global SpecMarten client skills.")
    .action(async () => {
      const summary = await runUpdate();
      printUpdateSummary(summary);
    });
}

export async function runUpdate(): Promise<CodexSkillInstallResult> {
  return installCodexSkills({ overwrite: true });
}

function printUpdateSummary(summary: CodexSkillInstallResult): void {
  const actions = summary.files.map((file) => `${file.path} ${file.action}`).join(", ");
  console.log(`${TOOL.displayName} updated Codex skills in ${summary.skillsDir}.`);
  console.log(actions);
}
