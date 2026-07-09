import { Command } from "commander";
import { readConfig } from "../config/config.js";
import { TOOL } from "../constants.js";
import { buildPlanContext } from "../core/context/plan-context.js";
import { runPlan } from "../core/planner/plan.js";
import { UserFacingError } from "../util/errors.js";
import {
  createHeadlessAgent,
  HEADLESS_OPTION_DESCRIPTION,
  isHeadlessRequested,
  type HeadlessAgentFactory
} from "./execution-mode.js";

export function registerPlanCommand(
  program: Command,
  deps: { createAgent?: HeadlessAgentFactory } = {}
): void {
  program
    .command("plan [requirement]")
    .description("Build client-first plan context by default; use --headless for automation/CI.")
    .option("--promote", "promote the current draft in specmarten/state.json")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .action(async (requirement: string | undefined, options: { promote?: boolean; headless?: boolean }) => {
      const root = process.cwd();
      const headless = isHeadlessRequested(options.headless || program.opts().headless);

      if (!options.promote && !headless) {
        if (!requirement?.trim()) {
          throw new UserFacingError("Plan requires a requirement description, for example: specmarten plan \"build login\".");
        }

        await buildPlanContext({ root, requirement });
        console.log(`${TOOL.displayName} plan is client-first by default.`);
        console.log(`Run \`$specmarten-plan ${requirement.trim()}\` in Codex to draft the roadmap with the current session.`);
        console.log(
          `Headless fallback: \`${TOOL.cliName} plan ${JSON.stringify(requirement.trim())} --headless\` or SPECMARTEN_HEADLESS=1.`
        );
        return;
      }

      const config = headless && !options.promote ? await readConfig(root) : undefined;
      const agent =
        headless && !options.promote ? await (deps.createAgent ?? createHeadlessAgent)(config!.agent.prefer) : undefined;
      const summary = await runPlan({
        root,
        requirement,
        agent,
        promote: options.promote
      });

      console.log(
        summary.promoted
          ? `${TOOL.displayName} promoted the current roadmap draft.`
          : `${TOOL.displayName} wrote a roadmap draft with ${summary.phases} phases and ${summary.tasks} tasks.`
      );
      if (summary.questions.length > 0) {
        console.log("Questions for human review:");
        for (const question of summary.questions) {
          console.log(`- ${question}`);
        }
      }
      console.log(`Next: review ${TOOL.dataDir}/roadmap.md, then run \`${TOOL.cliName} promote\` when ready.`);
    });
}
