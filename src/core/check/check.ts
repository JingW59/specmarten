import type { AgentRunner } from "../../adapters/agent/types.js";
import type { ChangeDetail, SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { UserFacingError } from "../../util/errors.js";
import { extractJsonObject } from "../../util/json.js";
import { applyLastPatrol, writePatrolReport, type PatrolVerdict } from "../overseer/patrol.js";
import { runTriage, type TriageResult } from "../overseer/triage.js";
import { readState, writeState } from "../state/store.js";
import { buildMaintainPrompt } from "../maintenance/prompt.js";
import { reconcileKnownLinks } from "../maintenance/reconcile.js";
import { maintainAgentResponseSchema, mergeAgentState, type MaintainAgentResponse } from "../maintenance/schema.js";
import { detectHardContractDrift } from "../overseer/hard-contract.js";

export interface CheckOptions {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
  agent?: AgentRunner;
  change?: string;
  diff?: string;
}

export interface CheckSummary {
  verdict: PatrolVerdict;
  report: string;
  exitCode: number;
  triage: TriageResult;
}

export async function runCheck(options: CheckOptions): Promise<CheckSummary> {
  const state = await readState(options.root);
  const [active, archived, specs] = await Promise.all([
    options.backend.listActiveChanges(),
    options.backend.listArchivedChanges(),
    options.backend.listSpecs()
  ]);
  const metas = [...active, ...archived];
  const selectedMetas = options.change ? metas.filter((change) => change.id === options.change) : metas;
  const changes = await Promise.all(selectedMetas.map((change) => options.backend.readChange(change.id)));
  if (options.change && changes.length === 0) {
    throw new UserFacingError(`Change not found in the configured backend: ${options.change}`);
  }

  const triage = await buildCheckTriage(options.root, options.config, options.diff);
  const hardContract = detectHardContractDrift(triage.diffText);
  if (hardContract) {
    const change = options.change ?? changes[0]?.id ?? "manual-check";
    const report = await writePatrolReport({
      root: options.root,
      change,
      reportBody: hardContract.report,
      agentName: "deterministic-hard-contract"
    });
    const nextState = { ...applyLastPatrol(state, report, change), updatedAt: new Date().toISOString() };
    await writeState(options.root, nextState);

    return {
      verdict: "BLOCK",
      report: report.reportRelativePath,
      exitCode: 2,
      triage: {
        ...triage,
        hit: true,
        reasons: [...triage.reasons, "deterministic hard-contract removal"]
      }
    };
  }

  if (!options.agent) {
    throw new UserFacingError("Check requires an available bring-your-own-agent CLI: claude, codex, or gemini.");
  }

  const prompt = buildMaintainPrompt({
    state,
    contentLanguage: options.config.language.content,
    changes,
    specs,
    triage: {
      ...triage,
      hit: true,
      reasons: triage.reasons.length ? triage.reasons : ["manual check"]
    }
  });
  // Real agents occasionally emit malformed JSON. Retry once, then degrade to a
  // WARN report instead of crashing the drift check.
  let response: MaintainAgentResponse | null = null;
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    const raw = await options.agent.run(prompt, { cwd: options.root });
    try {
      response = maintainAgentResponseSchema.parse(extractJsonObject(raw));
    } catch {
      response = null;
    }
  }
  const change = response?.patrol?.change ?? options.change ?? changes[0]?.id ?? "manual-check";
  const report = await writePatrolReport({
    root: options.root,
    change,
    reportBody: response?.patrol?.report ?? missingCheckReport(change),
    agentName: options.agent.name
  });
  const merged = response?.state ? mergeAgentState(state, response.state) : state;
  const reconciled = reconcileKnownLinks(merged, active, archived);
  const nextState = { ...applyLastPatrol(reconciled, report, change), updatedAt: new Date().toISOString() };
  await writeState(options.root, nextState);

  return {
    verdict: report.verdict,
    report: report.reportRelativePath,
    exitCode: report.verdict === "BLOCK" ? 2 : report.verdict === "WARN" ? 10 : 0,
    triage
  };
}

async function buildCheckTriage(root: string, config: SpecMartenConfig, diff?: string): Promise<TriageResult> {
  const triage = await runTriage(root, config.overseer);
  if (!diff) {
    return triage;
  }

  return {
    ...triage,
    hit: true,
    diffText: diff,
    reasons: [...triage.reasons, "manual diff input"]
  };
}

function missingCheckReport(change: string): string {
  return `# Overseer Patrol Report · ${change}
## Summary
The maintenance AI did not return a patrol report body. SpecMarten downgraded this patrol to WARN.
## Findings
| # | Dimension | Severity | Location (file:symbol) | Detail | Recommendation |
## State Update Recommendation
- None

VERDICT: WARN
`;
}
