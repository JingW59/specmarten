import { join } from "node:path";
import type { SpecBackend, ChangeDetail, ChangeMeta } from "../../adapters/spec-backend/types.js";
import { TOOL } from "../../constants.js";
import { createBaselineIfMissing } from "../baseline.js";
import { writeMaintainMarker } from "../maintenance/marker.js";
import { renderViews } from "../renderers/index.js";
import {
  collectPhases,
  singleStreamState,
  type SpecMartenPhase,
  type SpecMartenState,
  type SpecMartenStream,
  type SpecMartenTask
} from "../state/schema.js";
import { createInitialState, hasState, readState, writeState } from "../state/store.js";
import { writeJson, writeText } from "../../util/fs.js";
import {
  backfillAgentResponseSchema,
  type BackfillAgentResponse,
  type BackfillPhaseProposal,
  type BackfillStreamProposal
} from "./schema.js";
import { readBackfillSnapshot, type BackfillSnapshot } from "./snapshot.js";

export interface BackfillSummary {
  promoted: boolean;
  statePath: string;
  reportPath: string;
  changesRead: number;
  phases: number;
  tasks: number;
  lowConfidence: string[];
  superseded: string[];
  unlinkedChanges: string[];
  preservedFormalState: boolean;
  batches: number;
}

export interface BackfillDraftWriteOptions {
  root: string;
  backend: SpecBackend;
  response: BackfillAgentResponse;
}

export async function writeBackfillDraft(options: BackfillDraftWriteOptions): Promise<BackfillSummary> {
  const snapshot = await readBackfillSnapshot(options.backend);
  const response = backfillAgentResponseSchema.parse({
    ...options.response,
    phases: mergePhasesByTitle(options.response.phases)
  });

  return writeBackfillDraftFromSnapshot({
    root: options.root,
    backend: options.backend,
    response,
    snapshot,
    batches: 1
  });
}

export async function writeBackfillDraftFromSnapshot(input: {
  root: string;
  backend: SpecBackend;
  response: BackfillAgentResponse;
  snapshot: BackfillSnapshot;
  batches: number;
}): Promise<BackfillSummary> {
  const baseline = await createBaselineIfMissing(input.root, input.backend);
  const draftState = createDraftState(input.response, input.snapshot.changes, baseline);
  const existingState = (await hasState(input.root)) ? await readState(input.root) : null;
  const preserveFormalState = Boolean(existingState && !existingState.draft && collectPhases(existingState).length > 0);
  const stateTarget = preserveFormalState
    ? join(input.root, TOOL.dataDir, "backfill-state.draft.json")
    : join(input.root, TOOL.dataDir, "state.json");

  if (preserveFormalState) {
    await writeJson(stateTarget, draftState);
  } else {
    await writeState(input.root, draftState);
    await renderViews(input.root, draftState);
  }

  const reportPath = join(input.root, TOOL.dataDir, "backfill-report.md");
  await writeText(
    reportPath,
    renderBackfillReport({
      stateTarget,
      response: input.response,
      changes: input.snapshot.changes,
      preserveFormalState
    })
  );
  await writeMaintainMarker(input.root, await input.backend.getCurrentMarker());

  const phases = collectPhases(draftState);
  return {
    promoted: false,
    statePath: stateTarget,
    reportPath,
    changesRead: input.snapshot.changes.length,
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    lowConfidence: input.response.lowConfidence,
    superseded: input.response.superseded,
    unlinkedChanges: draftState.unlinkedChanges,
    preservedFormalState: preserveFormalState,
    batches: input.batches
  };
}

// At scale, batches each emit their own phases; consolidate phases that share a
// title (case-insensitive) so we don't get duplicate domain phases across batches.
export function mergePhasesByTitle(phases: BackfillAgentResponse["phases"]): BackfillAgentResponse["phases"] {
  const byTitle = new Map<string, BackfillAgentResponse["phases"][number]>();
  for (const phase of phases) {
    const key = phase.title.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.tasks.push(...phase.tasks);
    } else {
      byTitle.set(key, { id: phase.id, title: phase.title, tasks: [...phase.tasks] });
    }
  }
  return [...byTitle.values()];
}

export function createDraftState(
  response: BackfillAgentResponse,
  changes: ChangeDetail[],
  baseline: NonNullable<SpecMartenState["baseline"]>
): SpecMartenState {
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const superseded = new Set(response.superseded);

  // Stream-aware backfill output: preserve streams/tracks/supersedes/currentVersion,
  // infer each task's status/archivedAt from linked changes, exclude superseded
  // changes, and compute unlinkedChanges across every stream/track/phase.
  if (response.streams.length > 0) {
    const linked = new Set<string>();
    const streams = response.streams.map((stream, streamIndex) => buildStream(stream, streamIndex, changeById, superseded, linked));
    const unlinkedChanges = computeUnlinkedChanges(response.unlinkedChanges, changes, linked, superseded);
    const currentVersion = response.currentVersion || streams[0]?.version || "v1";
    return {
      ...createInitialState({ baseline }),
      draft: true,
      draftKind: "backfill",
      updatedAt: new Date().toISOString(),
      mission: response.mission,
      currentVersion,
      streams,
      unlinkedChanges
    };
  }

  // Legacy flat phases output: wrap into a single active stream.
  const phases = response.phases.map((phase, phaseIndex) =>
    enrichPhase(phase, `p${phaseIndex + 1}`, changeById, superseded)
  );
  const linked = new Set(phases.flatMap((phase) => phase.tasks.flatMap((task) => task.changes)));
  const unlinkedChanges = computeUnlinkedChanges(response.unlinkedChanges, changes, linked, superseded);

  return singleStreamState(
    {
      ...createInitialState({ baseline }),
      draft: true,
      draftKind: "backfill",
      updatedAt: new Date().toISOString(),
      mission: response.mission,
      unlinkedChanges
    },
    phases,
    { currentVersion: "v1" }
  );
}

// Infer status/archivedAt for a backfill phase proposal and assign stable ids.
function enrichPhase(
  phase: BackfillPhaseProposal,
  phaseId: string,
  changeById: Map<string, ChangeDetail>,
  superseded: Set<string>
): SpecMartenPhase {
  const tasks = phase.tasks.map((task, taskIndex) => {
    const changeIds = task.changes.filter((change) => changeById.has(change) && !superseded.has(change));
    const linkedChanges = changeIds.map((change) => changeById.get(change)!);
    return {
      id: task.id?.trim() || `${phaseId}.${taskIndex + 1}`,
      title: task.title,
      status: inferTaskStatus(linkedChanges),
      changes: changeIds,
      archivedAt: inferArchivedAt(linkedChanges),
      source: task.source
    } satisfies SpecMartenTask;
  });

  return {
    id: phase.id?.trim() || phaseId,
    title: phase.title,
    status: inferPhaseStatus(tasks),
    tasks
  } satisfies SpecMartenPhase;
}

function buildStream(
  stream: BackfillStreamProposal,
  streamIndex: number,
  changeById: Map<string, ChangeDetail>,
  superseded: Set<string>,
  linked: Set<string>
): SpecMartenStream {
  const id = stream.id?.trim() || stream.version?.trim() || `stream-${streamIndex + 1}`;
  const version = stream.version?.trim() || id;
  const label = stream.label?.trim() || version;

  const result: SpecMartenStream = {
    id,
    version,
    label,
    state: stream.state
  };
  if (stream.supersedes) {
    result.supersedes = stream.supersedes;
  }

  const tracks =
    stream.tracks && stream.tracks.length > 0
      ? stream.tracks.map((track, trackIndex) => {
          const trackId = track.id?.trim() || `${id}.t${trackIndex + 1}`;
          const trackLabel = track.label?.trim() || `Track ${trackIndex + 1}`;
          return {
            id: trackId,
            label: trackLabel,
            phases: track.phases.map((phase, phaseIndex) => {
              const built = enrichPhase(phase, `${trackId}.p${phaseIndex + 1}`, changeById, superseded);
              addLinked(built, linked);
              return built;
            })
          };
        })
      : [];
  const phases = (stream.phases ?? []).map((phase, phaseIndex) => {
    const built = enrichPhase(phase, `${id}.p${phaseIndex + 1}`, changeById, superseded);
    addLinked(built, linked);
    return built;
  });

  if (tracks.length > 0) {
    result.tracks = tracks;
  }
  if (phases.length > 0) {
    result.phases = phases;
  }
  if (!result.phases && !result.tracks) {
    result.phases = [];
  }
  return result;
}

function addLinked(phase: SpecMartenPhase, linked: Set<string>): void {
  for (const task of phase.tasks) {
    for (const change of task.changes) {
      linked.add(change);
    }
  }
}

function computeUnlinkedChanges(
  declared: string[],
  changes: ChangeDetail[],
  linked: Set<string>,
  superseded: Set<string>
): string[] {
  return [
    ...new Set([
      ...declared,
      ...changes.map((change) => change.id).filter((id) => !linked.has(id) && !superseded.has(id))
    ])
  ].sort((a, b) => a.localeCompare(b));
}

function inferTaskStatus(changes: ChangeMeta[]): SpecMartenTask["status"] {
  if (changes.length === 0) {
    return "todo";
  }

  return changes.every((change) => change.status === "archived" || change.taskProgress?.complete === true)
    ? "done"
    : "in-progress";
}

function inferPhaseStatus(tasks: SpecMartenTask[]): SpecMartenPhase["status"] {
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) {
    return "done";
  }

  return tasks.some((task) => task.status === "in-progress" || task.status === "done") ? "in-progress" : "planned";
}

function inferArchivedAt(changes: ChangeMeta[]): string | undefined {
  const archivedDates = changes
    .filter((change) => change.status === "archived")
    .map((change) => change.archivedAt)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => b.localeCompare(a));

  return archivedDates[0];
}

function renderBackfillReport(input: {
  stateTarget: string;
  response: BackfillAgentResponse;
  changes: ChangeDetail[];
  preserveFormalState: boolean;
}): string {
  const lines = [
    "# Backfill Report",
    "",
    `State draft: ${input.stateTarget}`,
    `Formal state preserved: ${input.preserveFormalState ? "yes" : "no"}`,
    "",
    "## Changes Read",
    ""
  ];

  for (const change of input.changes) {
    lines.push(`- ${change.id} (${change.status})${change.archivedAt ? ` archived ${change.archivedAt}` : ""}`);
  }

  lines.push("", "## Low Confidence", "");
  lines.push(...(input.response.lowConfidence.length ? input.response.lowConfidence.map((item) => `- ${item}`) : ["- none"]));
  lines.push("", "## Superseded", "");
  lines.push(...(input.response.superseded.length ? input.response.superseded.map((item) => `- ${item}`) : ["- none"]));
  lines.push("", "## Notes", "");
  lines.push(...(input.response.notes.length ? input.response.notes.map((item) => `- ${item}`) : ["- none"]));

  return `${lines.join("\n")}\n`;
}
