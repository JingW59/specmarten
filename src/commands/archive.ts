import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runArchive } from "../core/archive/archive.js";
import { resolveConfigAndBackend } from "./runtime-context.js";

export function registerArchiveCommand(program: Command): void {
  program
    .command("archive <change-id>")
    .description("Move a native change into the date-prefixed archive.")
    .option("--date <date>", "archive prefix date in YYYY-MM-DD (defaults to today)")
    .option("--json", "print machine-readable archive summary")
    .action(async (changeId: string, options: { date?: string; json?: boolean }) => {
      const root = process.cwd();
      const { backend } = await resolveConfigAndBackend(root);
      const summary = await runArchive({ root, backend, changeId, date: options.date });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`${TOOL.displayName} archived change ${summary.changeId} to ${summary.archivedTo}.`);
        console.log(`Next: run \`${TOOL.cliName} closeout\` to reconcile, refresh the baseline, and validate.`);
      }
    });
}
