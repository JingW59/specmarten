import { Command } from "commander";
import { OpenSpecBackend } from "../adapters/spec-backend/openspec.js";
import { readConfig } from "../config/config.js";
import { renderViews } from "../core/renderers/index.js";
import { readState } from "../core/state/store.js";
import { formatValidation, runValidate, type ValidationIssue } from "../core/validate/validate.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate SpecMarten state, generated views, config, agent availability, and baseline.")
    .option("--json", "print machine-readable validation result")
    .option("--fix", "repair generated roadmap/dashboard views before validating")
    .option("--complete", "fail when active OpenSpec checklists are not complete")
    .action(async (options: { json?: boolean; fix?: boolean; complete?: boolean }) => {
      const root = process.cwd();
      const config = await readConfig(root);
      if (options.fix) {
        await renderViews(root, await readState(root));
      }
      const summary = await runValidate({
        root,
        backend: new OpenSpecBackend(root),
        config,
        requireComplete: Boolean(options.complete)
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ...summary,
              viewsFixed: Boolean(options.fix),
              stateFixed: false,
              completionRequired: Boolean(options.complete),
              remainingIssues: summary.issues,
              recommendedCommand: recommendedCommand(summary.issues, Boolean(options.fix))
            },
            null,
            2
          )
        );
      } else {
        if (options.fix) {
          process.stdout.write("SpecMarten validate: generated views refreshed.\n");
        }
        process.stdout.write(formatValidation(summary));
      }
      process.exitCode = summary.ok ? 0 : 1;
    });
}

function recommendedCommand(issues: ValidationIssue[], viewsFixed: boolean): string | null {
  if (issues.some((issue) => issue.code === "backend-missing")) {
    return "specmarten init --bootstrap";
  }

  if (!viewsFixed && issues.some((issue) => issue.code === "roadmap-stale" || issue.code === "dashboard-stale")) {
    return "specmarten validate --fix";
  }

  if (issues.some((issue) => issue.code === "baseline-drift")) {
    return "specmarten closeout";
  }

  if (issues.some((issue) => issue.code === "specmarten-state-unreconciled")) {
    return "specmarten maintain";
  }

  if (
    issues.some((issue) =>
      ["openspec-active-unlinked", "openspec-archived-unlinked", "purpose-tbd"].includes(issue.code)
    )
  ) {
    return "$specmarten-maintain";
  }

  return issues.find((issue) => issue.fixCommand && issue.fixCommand !== "specmarten validate --fix")?.fixCommand ?? null;
}
