import { Command } from "commander";
import { createSpecBackend } from "../adapters/spec-backend/factory.js";
import { readConfig } from "../config/config.js";
import { TOOL } from "../constants.js";
import { runCheck } from "../core/check/check.js";
import { buildCheckContext } from "../core/context/check-context.js";
import { UserFacingError } from "../util/errors.js";
import {
  HEADLESS_OPTION_DESCRIPTION,
  isHeadlessRequested,
  maybeCreateHeadlessAgent,
  type AgentName,
  type HeadlessAgent
} from "./execution-mode.js";

type OptionalHeadlessAgentFactory = (prefer: AgentName[]) => Promise<HeadlessAgent | undefined>;

export function registerCheckCommand(
  program: Command,
  deps: { createAgent?: OptionalHeadlessAgentFactory } = {}
): void {
  program
    .command("check [change]")
    .description("Build client-first check context by default; use --headless for automation/CI.")
    .option("--change <id>", "change id to patrol")
    .option("--diff <text>", "diff text or diff summary to include in the patrol")
    .option("--json", "print machine-readable check summary")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .action(async (changeArg: string | undefined, options: { change?: string; diff?: string; json?: boolean; headless?: boolean }) => {
      const root = process.cwd();
      const change = options.change ?? changeArg;
      const headless = isHeadlessRequested(options.headless || program.opts().headless);

      if (!headless) {
        if (!change) {
          throw new UserFacingError("Check requires a change id, for example: specmarten check add-status-command.");
        }

        await buildCheckContext({ root, change });
        console.log(`${TOOL.displayName} check is client-first by default.`);
        console.log(`Run \`$specmarten-check ${change}\` in Codex to produce a PASS/WARN/BLOCK patrol report.`);
        console.log(`Headless fallback: \`${TOOL.cliName} check ${change} --headless\` or SPECMARTEN_HEADLESS=1.`);
        return;
      }

      const config = await readConfig(root);
      const agent = await (deps.createAgent ?? maybeCreateHeadlessAgent)(config.agent.prefer);
      const summary = await runCheck({
        root,
        backend: createSpecBackend(root, config.specBackend),
        config,
        agent,
        change,
        diff: options.diff
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`${TOOL.displayName} check: ${summary.verdict} (${summary.report})`);
      }
      process.exitCode = summary.exitCode;
    });
}
