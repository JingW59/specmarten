import { Command } from "commander";
import { TOOL } from "./constants.js";
import { registerArchiveCommand } from "./commands/archive.js";
import { registerBackfillCommand } from "./commands/backfill.js";
import { registerBaselineCommand } from "./commands/baseline.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerCloseoutCommand } from "./commands/closeout.js";
import { registerContextCommand } from "./commands/context.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMaintainCommand } from "./commands/maintain.js";
import { registerNewStreamCommand } from "./commands/new-stream.js";
import { registerNextCommand } from "./commands/next.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerPatrolCommand } from "./commands/patrol.js";
import { registerPromoteCommand } from "./commands/promote.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import { registerRenderCommand } from "./commands/render.js";
import { registerStateCommand } from "./commands/state.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerValidateCommand } from "./commands/validate.js";
import { HEADLESS_OPTION_DESCRIPTION } from "./commands/execution-mode.js";
import { errorToExitCode, errorToMessage } from "./util/errors.js";
import { installBrokenPipeHandlers } from "./util/stdio.js";

installBrokenPipeHandlers();

const COMMANDS: Array<{ register: (program: Command) => void; name: string; advanced?: boolean }> = [
  { register: registerArchiveCommand, name: "archive" },
  { register: registerInitCommand, name: "init" },
  { register: registerBaselineCommand, name: "baseline", advanced: true },
  { register: registerBackfillCommand, name: "backfill" },
  { register: registerCloseoutCommand, name: "closeout" },
  { register: registerDoctorCommand, name: "doctor" },
  { register: registerMaintainCommand, name: "maintain" },
  { register: registerNewStreamCommand, name: "new-stream" },
  { register: registerNextCommand, name: "next" },
  { register: registerPlanCommand, name: "plan" },
  { register: registerPatrolCommand, name: "patrol", advanced: true },
  { register: registerContextCommand, name: "context", advanced: true },
  { register: registerRenderCommand, name: "render", advanced: true },
  { register: registerPromoteCommand, name: "promote" },
  { register: registerReconcileCommand, name: "reconcile", advanced: true },
  { register: registerStateCommand, name: "state", advanced: true },
  { register: registerStatusCommand, name: "status" },
  { register: registerDashboardCommand, name: "dashboard" },
  { register: registerValidateCommand, name: "validate" },
  { register: registerCheckCommand, name: "check" },
  { register: registerUpdateCommand, name: "update" }
];

export function buildProgram(): Command {
  const program = new Command();

  program
    .name(TOOL.cliName)
    .description(`${TOOL.displayName}: AI-first project governance with a native ledger or OpenSpec backend.`)
    .version(TOOL.version)
    .option("--headless", HEADLESS_OPTION_DESCRIPTION);

  for (const command of COMMANDS) {
    command.register(program);
  }
  simplifyTopLevelHelp(program);

  return program;
}

function simplifyTopLevelHelp(program: Command): void {
  const help = program.createHelp();
  const advanced = new Set(COMMANDS.filter((command) => command.advanced).map((command) => command.name));
  program.configureHelp({
    visibleCommands(command) {
      const commands = help.visibleCommands(command);
      return command === program ? commands.filter((item) => !advanced.has(item.name())) : commands;
    }
  });
}

async function main(): Promise<void> {
  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(errorToMessage(error));
    process.exitCode = errorToExitCode(error);
  }
}

await main();
