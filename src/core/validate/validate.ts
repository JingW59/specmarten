import { join } from "node:path";
import { detectAvailableAgents } from "../../adapters/agent/detect.js";
import type { AgentName } from "../../adapters/agent/types.js";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import { type SpecMartenConfig } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { pathExists, readText } from "../../util/fs.js";
import { hasDeterministicReconcileChanges, reconcileKnownLinks } from "../maintenance/reconcile.js";
import { findPurposeTbdIssues, formatPurposeTbdIssue } from "../openspec/purpose.js";
import { renderDashboardHtml } from "../renderers/dashboard.js";
import { renderRoadmapMarkdown } from "../renderers/roadmap.js";
import { readState } from "../state/store.js";
import { VALIDATION_CODE } from "./codes.js";

export interface ValidationIssue {
  level: "error" | "warn";
  code: string;
  message: string;
  fixCommand?: string;
}

export interface ValidationSummary {
  ok: boolean;
  issues: ValidationIssue[];
}

interface ChangeValidationCodes {
  activeUnlinked: string;
  archivedUnlinked: string;
  activeIncomplete: string;
}

export async function runValidate(options: {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
  requireComplete?: boolean;
}): Promise<ValidationSummary> {
  const issues: ValidationIssue[] = [];
  const state = await readState(options.root);
  const backendPresent = await options.backend.isPresent();

  if (!backendPresent) {
    const backendLabel = options.config.specBackend === "native" ? "Native SpecMarten" : "OpenSpec";
    issues.push({
      level: "error",
      code: VALIDATION_CODE.BackendMissing,
      message: `${backendLabel} backend is not present.`,
      fixCommand:
        options.config.specBackend === "native"
          ? `${TOOL.cliName} init --backend native`
          : `${TOOL.cliName} init --bootstrap`
    });
  }

  const roadmapPath = join(options.root, TOOL.dataDir, "roadmap.md");
  const dashboardPath = join(options.root, TOOL.dataDir, "dashboard.html");
  await compareGeneratedView(roadmapPath, renderRoadmapMarkdown(state), VALIDATION_CODE.RoadmapStale, issues);
  await compareGeneratedView(
    dashboardPath,
    renderDashboardHtml(state, { contentLanguage: options.config.language.content }),
    VALIDATION_CODE.DashboardStale,
    issues
  );
  if (backendPresent) {
    const changeCodes = changeValidationCodes(options.config.specBackend);
    await detectBackendStateMismatches(options.backend, state, issues, {
      requireComplete: Boolean(options.requireComplete),
      changeCodes
    });
    if (options.config.specBackend === "openspec") {
      await detectPurposeTbdSpecs(options.backend, issues);
    }
  }

  const availableAgents = await detectAvailableAgents(options.config.agent.prefer as AgentName[]);
  if (availableAgents.length === 0) {
    issues.push({ level: "warn", code: VALIDATION_CODE.AgentMissing, message: "No claude/codex/gemini CLI detected." });
  }

  if (backendPresent && state.baseline) {
    const specsHash = await options.backend.getSpecsHash();
    if (specsHash !== state.baseline.specsHash) {
      issues.push({
        level: "warn",
        code: VALIDATION_CODE.BaselineDrift,
        message: `Current specs hash ${specsHash} differs from baseline ${state.baseline.specsHash}.`,
        fixCommand: `${TOOL.cliName} closeout`
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues
  };
}

export function formatValidation(summary: ValidationSummary): string {
  if (summary.issues.length === 0) {
    return "SpecMarten validate: OK\n";
  }

  return `${summary.ok ? "SpecMarten validate: OK with warnings" : "SpecMarten validate: FAILED"}\n${summary.issues
    .map((issue) => {
      const fix = issue.fixCommand ? `\n  Fix: ${issue.fixCommand}` : "";
      return `- ${issue.level.toUpperCase()} ${issue.code}: ${issue.message}${fix}`;
    })
    .join("\n")}\n`;
}

async function compareGeneratedView(
  path: string,
  expected: string,
  code: string,
  issues: ValidationIssue[]
): Promise<void> {
  if (!(await pathExists(path))) {
    issues.push({ level: "error", code, message: `${path} is missing.`, fixCommand: `${TOOL.cliName} validate --fix` });
    return;
  }

  const actual = await readText(path);
  if (actual !== expected) {
    issues.push({
      level: "warn",
      code,
      message: `${path} is stale relative to state.json.`,
      fixCommand: `${TOOL.cliName} validate --fix`
    });
  }
}

async function detectPurposeTbdSpecs(backend: SpecBackend, issues: ValidationIssue[]): Promise<void> {
  const purposeIssues = await findPurposeTbdIssues(backend);

  for (const issue of purposeIssues) {
    issues.push({
      level: "warn",
      code: VALIDATION_CODE.PurposeTbd,
      message: formatPurposeTbdIssue(issue),
      fixCommand: issue.fixCommand
    });
  }
}

async function detectBackendStateMismatches(
  backend: SpecBackend,
  state: Awaited<ReturnType<typeof readState>>,
  issues: ValidationIssue[],
  options: { requireComplete: boolean; changeCodes: ChangeValidationCodes }
): Promise<void> {
  const [activeChanges, archivedChanges] = await Promise.all([
    backend.listActiveChanges(),
    backend.listArchivedChanges()
  ]);
  const reconciled = reconcileKnownLinks(state, activeChanges, archivedChanges);

  if (options.requireComplete) {
    detectIncompleteActiveChecklists(activeChanges, issues, options.changeCodes.activeIncomplete);
    if (hasDeterministicReconcileChanges(state, reconciled)) {
      issues.push({
        level: "error",
        code: VALIDATION_CODE.StateUnreconciled,
        message: "SpecMarten state is not reconciled with current change checklist progress.",
        fixCommand: `${TOOL.cliName} maintain`
      });
    }
  }

  for (const change of reconciled.unlinkedActiveChanges) {
    issues.push({
      level: "warn",
      code: options.changeCodes.activeUnlinked,
      message: `Active change ${change} is not linked to any SpecMarten roadmap task.`,
      fixCommand: "$specmarten-maintain"
    });
  }

  for (const change of reconciled.unlinkedChanges) {
    issues.push({
      level: "warn",
      code: options.changeCodes.archivedUnlinked,
      message: `Archived change ${change} is not linked to any SpecMarten roadmap task.`,
      fixCommand: "$specmarten-maintain"
    });
  }
}

function detectIncompleteActiveChecklists(
  activeChanges: Awaited<ReturnType<SpecBackend["listActiveChanges"]>>,
  issues: ValidationIssue[],
  code: string
): void {
  for (const change of activeChanges) {
    if (change.taskProgress?.complete === true) {
      continue;
    }

    const progress = change.taskProgress
      ? `${change.taskProgress.completed}/${change.taskProgress.total} tasks complete`
      : "no checklist progress";
    issues.push({
      level: "error",
      code,
      message: `Active change ${change.id} is not complete (${progress}). Complete its tasks.md checklist before claiming done.`
    });
  }
}

function changeValidationCodes(backend: SpecMartenConfig["specBackend"]): ChangeValidationCodes {
  if (backend === "native") {
    return {
      activeUnlinked: VALIDATION_CODE.ChangeActiveUnlinked,
      archivedUnlinked: VALIDATION_CODE.ChangeArchivedUnlinked,
      activeIncomplete: VALIDATION_CODE.ChangeActiveIncomplete
    };
  }

  return {
    activeUnlinked: VALIDATION_CODE.OpenSpecActiveUnlinked,
    archivedUnlinked: VALIDATION_CODE.OpenSpecArchivedUnlinked,
    activeIncomplete: VALIDATION_CODE.OpenSpecActiveIncomplete
  };
}
