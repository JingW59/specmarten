import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runPromote } from "../core/promote/promote.js";

export function registerPromoteCommand(program: Command): void {
  program
    .command("promote")
    .description("Promote the current SpecMarten draft state and regenerate generated views.")
    .action(async () => {
      const summary = await runPromote({ root: process.cwd() });
      console.log(`${TOOL.displayName} promoted draft state.`);
      console.log(`State: ${summary.statePath}`);
      console.log(`Generated: ${TOOL.dataDir}/roadmap.md, ${TOOL.dataDir}/dashboard.html`);
    });
}
