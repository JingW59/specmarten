import { join } from "node:path";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import { TOOL } from "../../constants.js";
import { renderViews } from "../renderers/index.js";
import { readState, writeState } from "../state/store.js";
import { collectPhases, type SpecMartenState } from "../state/schema.js";
import { writeMaintainMarker } from "./marker.js";
import { reconcileKnownLinks } from "./reconcile.js";
import { maintainAgentResponseSchema, mergeAgentState, type MaintainAgentResponse } from "./schema.js";

export interface MaintainDraftWriteOptions {
  root: string;
  backend: SpecBackend;
  response: MaintainAgentResponse;
}

export interface MaintainDraftSummary {
  statePath: string;
  phases: number;
  tasks: number;
  unlinkedChanges: string[];
  notes: string[];
  rendered: boolean;
}

export async function writeMaintainDraft(options: MaintainDraftWriteOptions): Promise<MaintainDraftSummary> {
  const response = maintainAgentResponseSchema.parse(options.response);
  const [state, activeChanges, archivedChanges, currentMarker] = await Promise.all([
    readState(options.root),
    options.backend.listActiveChanges(),
    options.backend.listArchivedChanges(),
    options.backend.getCurrentMarker()
  ]);
  const reconciled = reconcileKnownLinks(state, activeChanges, archivedChanges);
  const nextState: SpecMartenState = {
    ...reconcileKnownLinks(
      response.state ? mergeAgentState(reconciled, response.state) : reconciled,
      activeChanges,
      archivedChanges
    ),
    updatedAt: new Date().toISOString()
  };

  await writeState(options.root, nextState);
  await renderViews(options.root, nextState);
  await writeMaintainMarker(options.root, currentMarker);
  const phases = collectPhases(nextState);

  return {
    statePath: join(options.root, TOOL.dataDir, "state.json"),
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    unlinkedChanges: nextState.unlinkedChanges,
    notes: response.notes,
    rendered: true
  };
}
