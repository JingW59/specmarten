import { join } from "node:path";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import { TOOL } from "../../constants.js";
import { refreshBaseline, type BaselineRefreshSummary } from "../baseline.js";
import { writeMaintainMarker } from "../maintenance/marker.js";
import { reconcileKnownLinks } from "../maintenance/reconcile.js";
import { renderViews } from "../renderers/index.js";
import { collectPhases } from "../state/schema.js";
import { readState, writeState } from "../state/store.js";

export interface ReconcileOptions {
  root: string;
  backend: SpecBackend;
  noRender?: boolean;
  acceptBaseline?: boolean;
}

export interface ReconcileSummary {
  statePath: string;
  phases: number;
  tasks: number;
  unlinkedActiveChanges: string[];
  unlinkedChanges: string[];
  rendered: boolean;
  baseline?: BaselineRefreshSummary;
}

export async function runReconcile(options: ReconcileOptions): Promise<ReconcileSummary> {
  const [state, activeChanges, archivedChanges, currentMarker] = await Promise.all([
    readState(options.root),
    options.backend.listActiveChanges(),
    options.backend.listArchivedChanges(),
    options.backend.getCurrentMarker()
  ]);
  const reconciled = {
    ...reconcileKnownLinks(state, activeChanges, archivedChanges),
    updatedAt: new Date().toISOString()
  };

  await writeState(options.root, reconciled);
  if (!options.noRender) {
    await renderViews(options.root, reconciled);
  }
  await writeMaintainMarker(options.root, currentMarker);
  const baseline = options.acceptBaseline
    ? await refreshBaseline({ root: options.root, backend: options.backend, noRender: options.noRender })
    : undefined;

  const phases = collectPhases(reconciled);
  return {
    statePath: join(options.root, TOOL.dataDir, "state.json"),
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    unlinkedActiveChanges: reconciled.unlinkedActiveChanges,
    unlinkedChanges: reconciled.unlinkedChanges,
    rendered: !options.noRender,
    baseline
  };
}
