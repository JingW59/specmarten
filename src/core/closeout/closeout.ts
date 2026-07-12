import type { AgentRunner } from "../../adapters/agent/types.js";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { refreshBaseline, type BaselineRefreshSummary } from "../baseline.js";
import { runMaintain, type MaintainSummary } from "../maintenance/maintain.js";
import { runReconcile, type ReconcileSummary } from "../reconcile/reconcile.js";
import { runValidate, type ValidationIssue, type ValidationSummary } from "../validate/validate.js";

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

const CLOSEOUT_BLOCKING_WARNINGS = new Set([
  "baseline-drift",
  "change-active-unlinked",
  "change-archived-unlinked",
  "openspec-active-unlinked",
  "openspec-archived-unlinked",
  "purpose-tbd",
  "roadmap-stale",
  "dashboard-stale"
]);
const PRE_BASELINE_BLOCKING_WARNINGS = new Set([
  "change-active-unlinked",
  "change-archived-unlinked",
  "openspec-active-unlinked",
  "openspec-archived-unlinked",
  "purpose-tbd",
  "roadmap-stale",
  "dashboard-stale"
]);

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
