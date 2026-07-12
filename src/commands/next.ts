import { Command } from "commander";
import { createSpecBackend } from "../adapters/spec-backend/factory.js";
import { readConfig } from "../config/config.js";
import { TOOL } from "../constants.js";
import { runNext } from "../core/next/next.js";

export function registerNextCommand(program: Command): void {
  program
    .command("next")
    .description("Show the next recommended command for the current SpecMarten state.")
    .option("--json", "print machine-readable next-step guidance")
    .action(async (options: { json?: boolean }) => {
      const root = process.cwd();
      const config = await readConfig(root);
      const summary = await runNext({ root, backend: createSpecBackend(root, config.specBackend), config });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`${TOOL.displayName} next: ${summary.command}`);
      console.log(`Reason: ${summary.reason}`);
      for (const detail of summary.details) {
        console.log(`- ${detail}`);
      }
    });
}
