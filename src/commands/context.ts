import { Command } from "commander";
import { buildBackfillContext } from "../core/context/backfill-context.js";
import { buildCheckContext } from "../core/context/check-context.js";
import { buildMaintainContext } from "../core/context/maintain-context.js";
import { buildPlanContext } from "../core/context/plan-context.js";
import { UserFacingError } from "../util/errors.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description("Build deterministic context for client-side AI workflows.")
    .requiredOption("--workflow <workflow>", "workflow to build context for; supports plan, backfill, check, and maintain")
    .option("--change <id>", "OpenSpec change id for check workflow")
    .option("--requirement <requirement>", "natural-language requirement for the workflow")
    .option("--group-by <mode>", "backfill grouping mode: capability, time, or flat", "capability")
    .option("--json", "print machine-readable context envelope")
    .action(
      async (options: {
        workflow: string;
        change?: string;
        requirement?: string;
        groupBy?: string;
        json?: boolean;
      }) => {
        if (options.workflow === "plan") {
          const envelope = await buildPlanContext({
            root: process.cwd(),
            requirement: options.requirement
          });

          console.log(JSON.stringify(envelope, null, 2));
          return;
        }

        if (options.workflow === "backfill") {
          const envelope = await buildBackfillContext({
            root: process.cwd(),
            groupBy: parseBackfillGroupBy(options.groupBy)
          });

          console.log(JSON.stringify(envelope, null, 2));
          return;
        }

        if (options.workflow === "check") {
          if (!options.change) {
            throw new UserFacingError("Check context requires --change <id>.");
          }

          const envelope = await buildCheckContext({
            root: process.cwd(),
            change: options.change
          });

          console.log(JSON.stringify(envelope, null, 2));
          return;
        }

        if (options.workflow === "maintain") {
          const envelope = await buildMaintainContext({
            root: process.cwd()
          });

          console.log(JSON.stringify(envelope, null, 2));
          return;
        }

        throw new UserFacingError("Context supports only --workflow plan, backfill, check, or maintain in this release.");
      }
    );
}

function parseBackfillGroupBy(value: string | undefined): "capability" | "time" | "flat" {
  if (value === "capability" || value === "time" || value === "flat") {
    return value;
  }

  throw new UserFacingError("Backfill context --group-by must be capability, time, or flat.");
}
