import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runCloseout } from "../core/closeout/closeout.js";
import { formatValidation } from "../core/validate/validate.js";
import {
  HEADLESS_OPTION_DESCRIPTION,
  maybeCreateHeadlessAgent,
  type HeadlessAgentFactory
} from "./execution-mode.js";
import { resolveHeadlessContext } from "./runtime-context.js";

export function registerCloseoutCommand(program: Command, deps: { createAgent?: HeadlessAgentFactory } = {}): void {
  program
    .command("closeout")
    .description("Run post-archive reconcile, render, baseline refresh, and validation in one command.")
    .option("--json", "print machine-readable closeout summary")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .action(async (options: { json?: boolean; headless?: boolean }) => {
      const root = process.cwd();
      const { config, backend, headless } = await resolveHeadlessContext(root, program, options);
      const agent = headless
        ? deps.createAgent
          ? await deps.createAgent(config.agent.prefer)
          : await maybeCreateHeadlessAgent(config.agent.prefer)
        : undefined;
      const summary = await runCloseout({ root, backend, config, agent, headless });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`${TOOL.displayName} closeout: ${summary.mode} reconcile complete, views rendered, baseline refreshed.`);
        if (summary.baseline) {
          console.log(`Baseline refreshed: ${summary.baseline.specsHash} (${summary.baseline.copiedFiles} files).`);
        }
        process.stdout.write(formatValidation(summary.validation));
        if (summary.blockingIssues.length > 0) {
          console.log(
            `${TOOL.displayName} closeout: unresolved blocking issue(s): ${summary.blockingIssues
              .map((issue) => issue.code)
              .join(", ")}.`
          );
        } else {
          console.log(`${TOOL.displayName} closeout: complete.`);
          console.log(`Next: run \`${TOOL.cliName} next\` to see the recommended next step.`);
        }
      }

      process.exitCode = summary.exitCode;
    });
}
