import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runBackfill } from "../core/backfill/backfill.js";
import { buildBackfillContext } from "../core/context/backfill-context.js";
import {
  createHeadlessAgent,
  HEADLESS_OPTION_DESCRIPTION,
  type HeadlessAgentFactory
} from "./execution-mode.js";
import { resolveHeadlessContext } from "./runtime-context.js";

export function registerBackfillCommand(
  program: Command,
  deps: { createAgent?: HeadlessAgentFactory } = {}
): void {
  program
    .command("backfill")
    .description("Build client-first backfill context by default; use --headless for automation/CI.")
    .option("--promote", "promote the current backfill draft in specmarten/state.json")
    .option("--group-by <mode>", "capability, time, or flat", "capability")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .action(async (options: { promote?: boolean; groupBy?: "capability" | "time" | "flat"; headless?: boolean }) => {
      const root = process.cwd();
      const { config, backend, headless } = await resolveHeadlessContext(root, program, options);

      if (!options.promote && !headless) {
        await buildBackfillContext({ root, groupBy: options.groupBy });
        console.log(`${TOOL.displayName} backfill is client-first by default.`);
        console.log("Run `$specmarten-backfill` in Codex to draft the roadmap from existing ledger changes.");
        console.log(`Headless fallback: \`${TOOL.cliName} backfill --headless\` or SPECMARTEN_HEADLESS=1.`);
        return;
      }

      const agent =
        headless && !options.promote ? await (deps.createAgent ?? createHeadlessAgent)(config.agent.prefer) : undefined;
      const summary = await runBackfill({
        root,
        backend,
        agent,
        promote: options.promote,
        groupBy: options.groupBy
      });

      console.log(
        summary.promoted
          ? `${TOOL.displayName} promoted backfill draft.`
          : `${TOOL.displayName} wrote a backfill draft with ${summary.phases} phases and ${summary.tasks} tasks.`
      );
      console.log(`State: ${summary.statePath}`);
      console.log(`Report: ${summary.reportPath}`);
      if (summary.preservedFormalState) {
        console.log("Existing formal state was preserved; review the separate draft state file.");
      }
    });
}
