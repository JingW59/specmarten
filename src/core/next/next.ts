import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { runStatus } from "../status/status.js";
import { runValidate } from "../validate/validate.js";

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

  if (issueCodes.has("backend-missing")) {
    return {
      command: "specmarten init --bootstrap",
      reason: "SpecMarten requires an OpenSpec project, but openspec/ is missing.",
      details: ["Run this in a repository where SpecMarten should manage an OpenSpec project."]
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
      reason: "OpenSpec changed and semantic maintenance is needed.",
      details: ["Use the client-first maintenance skill, or run specmarten maintain --headless in automation."]
    };
  }

  if (status.maintain.needsReconcile) {
    const command = issueCodes.has("baseline-drift") ? "specmarten closeout" : "specmarten maintain";
    return {
      command,
      reason: "OpenSpec changed since the last SpecMarten maintenance pass.",
      details: issueCodes.has("baseline-drift")
        ? ["This reconciles linked changes, regenerates views, refreshes the accepted baseline, and validates."]
        : ["This reconciles linked changes and regenerates generated views."]
    };
  }

  if (issueCodes.has("roadmap-stale") || issueCodes.has("dashboard-stale")) {
    return {
      command: "specmarten validate --fix",
      reason: "Generated views are stale or missing.",
      details: ["This regenerates specmarten/roadmap.md and specmarten/dashboard.html, then validates again."]
    };
  }

  if (issueCodes.has("baseline-drift")) {
    return {
      command: "specmarten closeout",
      reason: "Current OpenSpec specs differ from the accepted SpecMarten baseline.",
      details: ["This refreshes the accepted baseline and validates that no post-archive issues remain."]
    };
  }

  if (activeChanges.length === 1) {
    return {
      command: `openspec validate ${activeChanges[0]!.id} --strict`,
      reason: "One active OpenSpec change is present.",
      details: ["After implementation and validation, archive the change and run specmarten closeout."]
    };
  }

  if (activeChanges.length > 1) {
    return {
      command: "openspec validate <change-id> --strict",
      reason: "Multiple active OpenSpec changes are present.",
      details: [`Active changes: ${activeChanges.map((change) => change.id).join(", ")}`]
    };
  }

  return {
    command: "specmarten status",
    reason: "No immediate maintenance step is required.",
    details: ["Start the next change with native OpenSpec, or use $specmarten-plan for roadmap planning."]
  };
}
