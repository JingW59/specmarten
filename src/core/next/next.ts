import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { runStatus } from "../status/status.js";
import { runValidate } from "../validate/validate.js";
import { VALIDATION_CODE } from "../validate/codes.js";

export interface NextStepSummary {
  command: string;
  reason: string;
  details: string[];
}

export async function runNext(options: {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
}): Promise<NextStepSummary> {
  const [status, validation, activeChanges] = await Promise.all([
    runStatus(options),
    runValidate(options),
    options.backend.listActiveChanges()
  ]);
  const issueCodes = new Set(validation.issues.map((issue) => issue.code));
  const backendLabel = options.config.specBackend === "native" ? "native ledger" : "OpenSpec";

  if (issueCodes.has(VALIDATION_CODE.BackendMissing)) {
    return {
      command: options.config.specBackend === "native" ? "specmarten init --backend native" : "specmarten init --bootstrap",
      reason: `The configured ${backendLabel} backend is missing.`,
      details: ["Initialize the configured backend in this repository."]
    };
  }

  if (status.state.draft) {
    return {
      command: "specmarten promote",
      reason: "A draft roadmap/state is waiting for review.",
      details: ["Review specmarten/roadmap.md first, then promote the draft."]
    };
  }

  if (status.maintain.needsAgent) {
    return {
      command: "$specmarten-maintain",
      reason: `The ${backendLabel} changed and semantic maintenance is needed.`,
      details: ["Use the client-first maintenance skill, or run specmarten maintain --headless in automation."]
    };
  }

  if (status.maintain.needsReconcile) {
    const command = issueCodes.has(VALIDATION_CODE.BaselineDrift) ? "specmarten closeout" : "specmarten maintain";
    return {
      command,
      reason: `The ${backendLabel} changed since the last SpecMarten maintenance pass.`,
      details: issueCodes.has(VALIDATION_CODE.BaselineDrift)
        ? ["This reconciles linked changes, regenerates views, refreshes the accepted baseline, and validates."]
        : ["This reconciles linked changes and regenerates generated views."]
    };
  }

  if (issueCodes.has(VALIDATION_CODE.RoadmapStale) || issueCodes.has(VALIDATION_CODE.DashboardStale)) {
    return {
      command: "specmarten validate --fix",
      reason: "Generated views are stale or missing.",
      details: ["This regenerates specmarten/roadmap.md and specmarten/dashboard.html, then validates again."]
    };
  }

  if (issueCodes.has(VALIDATION_CODE.BaselineDrift)) {
    return {
      command: "specmarten closeout",
      reason: `Current ${backendLabel} specs differ from the accepted SpecMarten baseline.`,
      details: ["This refreshes the accepted baseline and validates that no post-archive issues remain."]
    };
  }

  if (activeChanges.length === 1) {
    const activeChange = activeChanges[0]!;
    return {
      command:
        options.config.specBackend === "native"
          ? "specmarten validate --complete"
          : `openspec validate ${activeChange.id} --strict`,
      reason: `One active ${backendLabel} change is present.`,
      details:
        options.config.specBackend === "native"
          ? [`Complete specmarten/ledger/changes/${activeChange.id}/tasks.md, then archive it and run specmarten closeout.`]
          : ["After implementation and validation, archive the change and run specmarten closeout."]
    };
  }

  if (activeChanges.length > 1) {
    return {
      command: options.config.specBackend === "native" ? "specmarten validate --complete" : "openspec validate <change-id> --strict",
      reason: `Multiple active ${backendLabel} changes are present.`,
      details: [`Active changes: ${activeChanges.map((change) => change.id).join(", ")}`]
    };
  }

  return {
    command: "specmarten status",
    reason: "No immediate maintenance step is required.",
    details: [
      options.config.specBackend === "native"
        ? "Start the next change under specmarten/ledger/changes/, or use $specmarten-plan for roadmap planning."
        : "Start the next change with native OpenSpec, or use $specmarten-plan for roadmap planning."
    ]
  };
}
