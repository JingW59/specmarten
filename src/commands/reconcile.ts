import { Command } from "commander";
import { OpenSpecBackend } from "../adapters/spec-backend/openspec.js";
import { TOOL } from "../constants.js";
import { runReconcile } from "../core/reconcile/reconcile.js";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Run deterministic SpecMarten state reconciliation and regenerate views.")
    .option("--json", "print machine-readable reconcile summary")
    .action(async (options: { json?: boolean }) => {
      const root = process.cwd();
      const summary = await runReconcile({
        root,
        backend: new OpenSpecBackend(root)
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(
          `${TOOL.displayName} reconcile: ${summary.phases} phases, ${summary.tasks} tasks, ${summary.unlinkedActiveChanges.length} unlinked active changes, ${summary.unlinkedChanges.length} unlinked archived changes.`
        );
      }
    });
}
