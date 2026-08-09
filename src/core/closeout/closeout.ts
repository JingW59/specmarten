import type { AgentRunner } from "../../adapters/agent/types.js";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { refreshBaseline, type BaselineRefreshSummary } from "../baseline.js";
import { runMaintain, type MaintainSummary } from "../maintenance/maintain.js";
import { runReconcile, type ReconcileSummary } from "../reconcile/reconcile.js";
import { runValidate, type ValidationIssue, type ValidationSummary } from "../validate/validate.js";
import { VALIDATION_CODE } from "../validate/codes.js";

export interface CloseoutOptions {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
  agent?: AgentRunner;
  headless?: boolean;
}

export interface CloseoutSummary {
  mode: "deterministic" | "headless";
  maintenance: ReconcileSummary | MaintainSummary;
  baseline?: BaselineRefreshSummary;
  validation: ValidationSummary;
  blockingIssues: ValidationIssue[];
  exitCode: number;
}

// Warn-level codes that block a clean closeout once the baseline has refreshed.
// Drift after a refresh signals a genuine problem (specs changed mid-closeout,
// or the refresh failed silently), so it blocks here.
const CLOSEOUT_BLOCKING_WARNINGS: Set<string> = new Set([
  VALIDATION_CODE.BaselineDrift,
  VALIDATION_CODE.ChangeActiveUnlinked,
  VALIDATION_CODE.ChangeArchivedUnlinked,
  VALIDATION_CODE.OpenSpecActiveUnlinked,
  VALIDATION_CODE.OpenSpecArchivedUnlinked,
  VALIDATION_CODE.PurposeTbd,
  VALIDATION_CODE.RoadmapStale,
  VALIDATION_CODE.DashboardStale
]);
// Pre-baseline, drift is the expected normal state — closeout exists to resolve
// it. Derived from the full set rather than re-listed, so the two can never
// silently drift apart.
const PRE_BASELINE_BLOCKING_WARNINGS: Set<string> = new Set(
  [...CLOSEOUT_BLOCKING_WARNINGS].filter((code) => code !== VALIDATION_CODE.BaselineDrift)
);

export async function runCloseout(options: CloseoutOptions): Promise<CloseoutSummary> {
  if (options.headless) {
    const maintenance = await runMaintain({
      root: options.root,
      backend: options.backend,
      config: options.config,
      agent: options.agent
    });
    const preBaselineValidation = await runValidate(options);
    const preBaselineBlockingIssues = preBaselineValidation.issues.filter(isPreBaselineBlockingIssue);
    if (maintenance.exitCode !== 0 || preBaselineBlockingIssues.length > 0) {
      return {
        mode: "headless",
        maintenance,
        validation: preBaselineValidation,
        blockingIssues: preBaselineBlockingIssues,
        exitCode: maintenance.exitCode !== 0 ? maintenance.exitCode : 1
      };
    }

    const baseline = await refreshBaseline({ root: options.root, backend: options.backend });
    const validation = await runValidate(options);
    const blockingIssues = validation.issues.filter(isCloseoutBlockingIssue);

    return {
      mode: "headless",
      maintenance,
      baseline,
      validation,
      blockingIssues,
      exitCode: maintenance.exitCode !== 0 ? maintenance.exitCode : blockingIssues.length > 0 ? 1 : 0
    };
  }

  const maintenance = await runReconcile({
    root: options.root,
    backend: options.backend
  });
  const preBaselineValidation = await runValidate(options);
  const preBaselineBlockingIssues = preBaselineValidation.issues.filter(isPreBaselineBlockingIssue);
  if (preBaselineBlockingIssues.length > 0) {
    return {
      mode: "deterministic",
      maintenance,
      validation: preBaselineValidation,
      blockingIssues: preBaselineBlockingIssues,
      exitCode: 1
    };
  }

  const baseline = await refreshBaseline({ root: options.root, backend: options.backend });
  const validation = await runValidate(options);
  const blockingIssues = validation.issues.filter(isCloseoutBlockingIssue);

  return {
    mode: "deterministic",
    maintenance,
    baseline,
    validation,
    blockingIssues,
    exitCode: blockingIssues.length > 0 ? 1 : 0
  };
}

function isCloseoutBlockingIssue(issue: ValidationIssue): boolean {
  return issue.level === "error" || CLOSEOUT_BLOCKING_WARNINGS.has(issue.code);
}

function isPreBaselineBlockingIssue(issue: ValidationIssue): boolean {
  return issue.level === "error" || PRE_BASELINE_BLOCKING_WARNINGS.has(issue.code);
}
