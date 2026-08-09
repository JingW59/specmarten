import { Command, Help } from "commander";
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

type CommandGroup = "start" | "lifecycle" | "inspection";

interface CommandEntry {
  register: (program: Command) => void;
  name: string;
  group: CommandGroup;
  advanced?: boolean;
}

const COMMANDS: CommandEntry[] = [
  { register: registerInitCommand, name: "init", group: "start" },
  { register: registerNextCommand, name: "next", group: "start" },
  { register: registerStatusCommand, name: "status", group: "start" },
  { register: registerPlanCommand, name: "plan", group: "lifecycle" },
  { register: registerBackfillCommand, name: "backfill", group: "lifecycle" },
  { register: registerMaintainCommand, name: "maintain", group: "lifecycle" },
  { register: registerCheckCommand, name: "check", group: "lifecycle" },
  { register: registerArchiveCommand, name: "archive", group: "lifecycle" },
  { register: registerCloseoutCommand, name: "closeout", group: "lifecycle" },
  { register: registerPromoteCommand, name: "promote", group: "lifecycle" },
  { register: registerNewStreamCommand, name: "new-stream", group: "lifecycle" },
  { register: registerValidateCommand, name: "validate", group: "inspection" },
  { register: registerDashboardCommand, name: "dashboard", group: "inspection" },
  { register: registerDoctorCommand, name: "doctor", group: "inspection" },
  { register: registerUpdateCommand, name: "update", group: "inspection" },
  // Advanced/internal commands: hidden from top-level help, available for skills, hooks, and automation.
  { register: registerBaselineCommand, name: "baseline", group: "inspection", advanced: true },
  { register: registerPatrolCommand, name: "patrol", group: "inspection", advanced: true },
  { register: registerContextCommand, name: "context", group: "inspection", advanced: true },
  { register: registerRenderCommand, name: "render", group: "inspection", advanced: true },
  { register: registerReconcileCommand, name: "reconcile", group: "inspection", advanced: true },
  { register: registerStateCommand, name: "state", group: "inspection", advanced: true }
];

const GROUP_LABELS: Array<{ group: CommandGroup; label: string }> = [
  { group: "start", label: "Getting started" },
  { group: "lifecycle", label: "Changes & lifecycle" },
  { group: "inspection", label: "Inspection & views" }
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
  configureGroupedHelp(program);

  return program;
}

/**
 * Reorganises the top-level --help so the visible commands read as three
 * focused groups instead of an alphabetical wall. Subcommand help is untouched.
 * Advanced/internal commands are marked hidden on the commander instance so the
 * default visibility logic filters them, and are grouped out of the help block.
 */
function configureGroupedHelp(program: Command): void {
  const advanced = new Set(COMMANDS.filter((command) => command.advanced).map((command) => command.name));

  // Hide advanced subcommands via commander's native _hidden flag so every
  // visibility/completion path (not just our help formatter) agrees.
  for (const sub of program.commands) {
    if (advanced.has(sub.name())) {
      (sub as Command & { _hidden?: boolean })._hidden = true;
    }
  }

  const visibleByGroup = new Map<CommandGroup, Command[]>();
  for (const { group, name } of COMMANDS) {
    if (advanced.has(name)) continue;
    const sub = program.commands.find((cmd) => cmd.name() === name);
    if (!sub) continue;
    const bucket = visibleByGroup.get(group) ?? [];
    bucket.push(sub);
    visibleByGroup.set(group, bucket);
  }

  program.configureHelp({
    // Replace the flat "Commands:" block with one section per group. We call the
    // prototype formatter for everything else and only rewrite the tail.
    formatHelp(command, helper) {
      const base = Help.prototype.formatHelp(command, helper);
      if (command !== program || typeof base !== "string") return base;

      const termWidth = Math.max(
        helper.padWidth(command, helper),
        ...[...visibleByGroup.values()].flat().map((cmd) => helper.subcommandTerm(cmd).length)
      );
      const sections = GROUP_LABELS.map(({ group, label }) => {
        const commands = visibleByGroup.get(group) ?? [];
        if (commands.length === 0) return "";
        const items = commands.map((cmd) =>
          helper.wrap(
            `${helper.subcommandTerm(cmd).padEnd(termWidth + 2)}${helper.subcommandDescription(cmd)}`,
            (helper.helpWidth || 80) - 2,
            termWidth + 2
          )
        );
        return `${label}:\n${items.map((item) => `  ${item.replace(/\n/g, "\n  ")}`).join("\n")}`;
      }).filter(Boolean);

      return base.replace(/Commands:\n[\s\S]*$/, sections.join("\n\n"));
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
