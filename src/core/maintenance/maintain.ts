import type { AgentRunner } from "../../adapters/agent/types.js";
import type { ChangeDetail, SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { UserFacingError } from "../../util/errors.js";
import { extractJsonObject } from "../../util/json.js";
import { renderViews } from "../renderers/index.js";
import { readState, writeState } from "../state/store.js";
import { applyLastPatrol, writePatrolReport } from "../overseer/patrol.js";
import { runTriage, type TriageResult } from "../overseer/triage.js";
import { readMaintainMarker, writeMaintainMarker } from "./marker.js";
import { buildMaintainPrompt } from "./prompt.js";
import { hasDeterministicReconcileChanges, hasNewUnlinkedChanges, reconcileKnownLinks } from "./reconcile.js";
import { maintainAgentResponseSchema, mergeAgentState, type MaintainAgentResponse } from "./schema.js";

export interface MaintainOptions {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
  agent?: AgentRunner;
  since?: string;
  noRender?: boolean;
  preArchive?: boolean;
}

export interface MaintainSummary {
  changed: boolean;
  earlyExit: boolean;
  triage: TriageResult;
  agentCalled: boolean;
  rendered: boolean;
  report?: string;
  verdict?: "PASS" | "WARN" | "BLOCK";
  exitCode: number;
}

export async function runMaintain(options: MaintainOptions): Promise<MaintainSummary> {
  const currentMarker = await options.backend.getCurrentMarker();
  const previousMarker = options.since ?? (await readMaintainMarker(options.root));
  const unchanged = previousMarker !== undefined && previousMarker === currentMarker;
  const emptyTriage: TriageResult = { hit: false, changedFiles: [], diffText: "", reasons: [] };
  const [activeMetas, archivedMetas, state] = await Promise.all([
    options.backend.listActiveChanges(),
    options.backend.listArchivedChanges(),
    readState(options.root)
  ]);
  const reconciled = reconcileKnownLinks(state, activeMetas, archivedMetas);
  const reconcileChanged = hasDeterministicReconcileChanges(state, reconciled);
  const hasUnlinkedChanges = reconciled.unlinkedActiveChanges.length > 0 || reconciled.unlinkedChanges.length > 0;

  if (unchanged && !reconcileChanged && !hasUnlinkedChanges) {
    return {
      changed: false,
      earlyExit: true,
      triage: emptyTriage,
      agentCalled: false,
      rendered: false,
      exitCode: 0
    };
  }

  const triage = await runTriage(options.root, options.config.overseer);
  const needsAgent = triage.hit || hasUnlinkedChanges || hasNewUnlinkedChanges(state, reconciled);
  let nextState = reconciled;
  let agentCalled = false;
  let report: string | undefined;
  let verdict: MaintainSummary["verdict"];

  if (needsAgent) {
    if (!options.agent) {
      throw new UserFacingError("Maintain requires an available bring-your-own-agent CLI: claude, codex, or gemini.");
    }

    agentCalled = true;
    const [changes, specs] = await Promise.all([
      Promise.all([...activeMetas, ...archivedMetas].map((change) => options.backend.readChange(change.id))),
      options.backend.listSpecs()
    ]);
    const prompt = buildMaintainPrompt({
      state: reconciled,
      contentLanguage: options.config.language.content,
      changes,
      specs,
      triage
    });
    // Real agents occasionally emit malformed JSON. Retry once, then degrade
    // (keep the deterministic reconcile + a WARN patrol) instead of crashing.
    let response: MaintainAgentResponse | null = null;
    for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
      const raw = await options.agent.run(prompt, { cwd: options.root });
      try {
        response = maintainAgentResponseSchema.parse(extractJsonObject(raw));
      } catch {
        response = null;
      }
    }
    nextState = reconcileKnownLinks(
      response?.state ? mergeAgentState(reconciled, response.state) : reconciled,
      activeMetas,
      archivedMetas
    );

    if (triage.hit) {
      const change = response?.patrol?.change ?? choosePatrolChange(changes);
      const written = await writePatrolReport({
        root: options.root,
        change,
        reportBody: response?.patrol?.report ?? missingPatrolReport(change),
        agentName: options.agent.name
      });
      nextState = applyLastPatrol(nextState, written, change);
      report = written.reportRelativePath;
      verdict = written.verdict;
    }
  }

  nextState = {
    ...nextState,
    updatedAt: new Date().toISOString()
  };
  await writeState(options.root, nextState);
  if (!options.noRender && options.config.maintain.autoRenderViews) {
    await renderViews(options.root, nextState);
  }
  await writeMaintainMarker(options.root, currentMarker);

  const exitCode = options.preArchive && options.config.overseer.blocking === "pre-archive-block" && verdict === "BLOCK" ? 2 : 0;

  return {
    changed: true,
    earlyExit: false,
    triage,
    agentCalled,
    rendered: !options.noRender && options.config.maintain.autoRenderViews,
    report,
    verdict,
    exitCode
  };
}

function choosePatrolChange(changes: ChangeDetail[]): string {
  const archived = changes.filter((change) => change.status === "archived");
  const candidates = archived.length > 0 ? archived : changes;
  return candidates.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") || a.id.localeCompare(b.id))[0]?.id ?? "unknown-change";
}

function missingPatrolReport(change: string): string {
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
