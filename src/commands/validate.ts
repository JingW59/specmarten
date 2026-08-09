import { Command } from "commander";
import { renderViews } from "../core/renderers/index.js";
import { readState } from "../core/state/store.js";
import { formatValidation, runValidate, type ValidationIssue } from "../core/validate/validate.js";
import { VALIDATION_CODE } from "../core/validate/codes.js";
import { resolveConfigAndBackend } from "./runtime-context.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate SpecMarten state, generated views, config, agent availability, and baseline.")
    .option("--json", "print machine-readable validation result")
    .option("--fix", "repair generated roadmap/dashboard views before validating")
    .option("--complete", "fail when active change checklists are not complete")
    .action(async (options: { json?: boolean; fix?: boolean; complete?: boolean }) => {
      const root = process.cwd();
      const { config, backend } = await resolveConfigAndBackend(root);
      if (options.fix) {
        await renderViews(root, await readState(root));
      }
      const summary = await runValidate({
        root,
        backend,
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
              recommendedCommand: recommendedCommand(summary.issues, Boolean(options.fix), config.specBackend)
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

function recommendedCommand(
  issues: ValidationIssue[],
  viewsFixed: boolean,
  backend: "native" | "openspec"
): string | null {
  if (issues.some((issue) => issue.code === VALIDATION_CODE.BackendMissing)) {
    return backend === "native" ? "specmarten init --backend native" : "specmarten init --bootstrap";
  }

  if (
    !viewsFixed &&
    issues.some((issue) => issue.code === VALIDATION_CODE.RoadmapStale || issue.code === VALIDATION_CODE.DashboardStale)
  ) {
    return "specmarten validate --fix";
  }

  if (issues.some((issue) => issue.code === VALIDATION_CODE.StateUnreconciled)) {
    return "specmarten maintain";
  }

  const maintainCodes: readonly string[] = [
    VALIDATION_CODE.ChangeActiveUnlinked,
    VALIDATION_CODE.ChangeArchivedUnlinked,
    VALIDATION_CODE.OpenSpecActiveUnlinked,
    VALIDATION_CODE.OpenSpecArchivedUnlinked,
    VALIDATION_CODE.PurposeTbd
  ];
  if (issues.some((issue) => maintainCodes.includes(issue.code))) {
    return "$specmarten-maintain";
  }

  if (issues.some((issue) => issue.code === VALIDATION_CODE.BaselineDrift)) {
    return "specmarten closeout";
  }

  return issues.find((issue) => issue.fixCommand && issue.fixCommand !== "specmarten validate --fix")?.fixCommand ?? null;
}
