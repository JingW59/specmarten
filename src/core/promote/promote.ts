import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { renderViews } from "../renderers/index.js";
import { promoteDraftState } from "../state/store.js";
import { collectPhases, type SpecMartenState } from "../state/schema.js";

export interface PromoteSummary {
  statePath: string;
  phases: number;
  tasks: number;
  state: SpecMartenState;
}

export async function runPromote(options: { root: string }): Promise<PromoteSummary> {
  const state = await promoteDraftState(options.root);
  await renderViews(options.root, state);
  const phases = collectPhases(state);

  return {
    statePath: join(options.root, TOOL.dataDir, "state.json"),
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    state
  };
}
