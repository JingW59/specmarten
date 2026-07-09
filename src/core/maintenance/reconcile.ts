import type { ChangeMeta } from "../../adapters/spec-backend/types.js";
import {
  collectPhases,
  mapPhasesInState,
  type SpecMartenPhase,
  type SpecMartenState,
  type SpecMartenTask
} from "../state/schema.js";

export interface SuggestedChangeLink {
  change: string;
  task: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export function reconcileKnownLinks(
  state: SpecMartenState,
  activeChanges: ChangeMeta[],
  archivedChanges: ChangeMeta[]
): SpecMartenState {
  const activeById = new Map(activeChanges.map((change) => [change.id, change]));
  const archivedByLinkedId = buildArchivedLinkedIdMap(archivedChanges);
  const linked = new Set<string>();
  const linkedArchivedIds = new Set<string>();

  const nextState = mapPhasesInState(state, (phase) => {
    const tasks = phase.tasks.map((task) => {
      for (const changeId of task.changes) {
        linked.add(changeId);
      }

      return reconcileTask(task, activeById, archivedByLinkedId, linkedArchivedIds);
    });

    return {
      ...phase,
      status: inferPhaseStatus(tasks),
      tasks
    } satisfies SpecMartenPhase;
  });
  const unlinkedArchived = archivedChanges
    .map((change) => change.id)
    .filter((id) => !linked.has(id) && !linkedArchivedIds.has(id));
  const unlinkedActive = activeChanges.map((change) => change.id).filter((id) => !linked.has(id));

  return {
    ...nextState,
    unlinkedActiveChanges: [...new Set(unlinkedActive)].sort((a, b) => a.localeCompare(b)),
    unlinkedChanges: [...new Set(unlinkedArchived)].sort((a, b) => a.localeCompare(b))
  };
}

export function hasNewUnlinkedChanges(before: SpecMartenState, after: SpecMartenState): boolean {
  const beforeActiveUnlinked = new Set(before.unlinkedActiveChanges);
  const beforeUnlinked = new Set(before.unlinkedChanges);
  return (
    after.unlinkedActiveChanges.some((change) => !beforeActiveUnlinked.has(change)) ||
    after.unlinkedChanges.some((change) => !beforeUnlinked.has(change))
  );
}

export function hasDeterministicReconcileChanges(before: SpecMartenState, after: SpecMartenState): boolean {
  return JSON.stringify(withoutUpdatedAt(before)) !== JSON.stringify(withoutUpdatedAt(after));
}

export function suggestLinksForUnlinkedChanges(
  state: SpecMartenState,
  changes: ChangeMeta[]
): SuggestedChangeLink[] {
  const changesById = buildChangeAliasMap(changes);
  const tasks = collectPhases(state).flatMap((phase) => phase.tasks);

  return [...state.unlinkedActiveChanges, ...state.unlinkedChanges]
    .map((changeId) => {
      const change = changesById.get(changeId);
      if (!change) {
        return undefined;
      }

      return bestSuggestedLink(change, tasks, changesById);
    })
    .filter((link): link is SuggestedChangeLink => Boolean(link))
    .sort((a, b) => a.change.localeCompare(b.change));
}

function reconcileTask(
  task: SpecMartenTask,
  activeById: Map<string, ChangeMeta>,
  archivedByLinkedId: Map<string, ChangeMeta>,
  linkedArchivedIds: Set<string>
): SpecMartenTask {
  const active = task.changes
    .map((change) => activeById.get(change))
    .filter((change): change is ChangeMeta => Boolean(change));
  const incompleteActive = active.filter((change) => !isChecklistComplete(change));
  const completeActive = active.filter(isChecklistComplete);
  const archived = task.changes
    .map((change) => archivedByLinkedId.get(change))
    .filter((change): change is ChangeMeta => Boolean(change));

  for (const change of archived) {
    linkedArchivedIds.add(change.id);
  }

  if (incompleteActive.length > 0) {
    return {
      ...task,
      status: "in-progress"
    };
  }

  if (task.changes.length > 0 && archived.length + completeActive.length === task.changes.length) {
    return {
      ...task,
      status: "done",
      archivedAt: latestArchivedAt(archived) ?? task.archivedAt
    };
  }

  return task;
}

function isChecklistComplete(change: ChangeMeta): boolean {
  return change.taskProgress?.complete === true;
}

function buildArchivedLinkedIdMap(changes: ChangeMeta[]): Map<string, ChangeMeta> {
  const map = new Map<string, ChangeMeta>();
  for (const change of changes) {
    map.set(change.id, change);
    const originalId = originalIdFromArchiveId(change.id);
    if (originalId) {
      map.set(originalId, change);
    }
  }

  return map;
}

function buildChangeAliasMap(changes: ChangeMeta[]): Map<string, ChangeMeta> {
  const map = new Map<string, ChangeMeta>();
  for (const change of changes) {
    map.set(change.id, change);
    const originalId = originalIdFromArchiveId(change.id);
    if (originalId && !map.has(originalId)) {
      map.set(originalId, change);
    }
  }

  return map;
}

function bestSuggestedLink(
  change: ChangeMeta,
  tasks: SpecMartenTask[],
  changesById: Map<string, ChangeMeta>
): SuggestedChangeLink | undefined {
  const scored = tasks
    .map((task) => scoreTaskForChange(change, task, changesById))
    .filter((link): link is SuggestedChangeLink & { score: number } => Boolean(link))
    .sort((a, b) => b.score - a.score || a.task.localeCompare(b.task));

  const best = scored[0];
  return best
    ? {
        change: best.change,
        task: best.task,
        confidence: best.confidence,
        reason: best.reason
      }
    : undefined;
}

function scoreTaskForChange(
  change: ChangeMeta,
  task: SpecMartenTask,
  changesById: Map<string, ChangeMeta>
): (SuggestedChangeLink & { score: number }) | undefined {
  const specOverlap = commonSpecs(
    change.specsTouched,
    task.changes.flatMap((changeId) => changesById.get(changeId)?.specsTouched ?? [])
  );
  if (specOverlap.length > 0) {
    return {
      change: change.id,
      task: task.id,
      confidence: "high",
      reason: `same spec: ${specOverlap[0]}`,
      score: 3
    };
  }

  const changeTokens = tokenize([change.id, change.title ?? ""]);
  const taskTokens = tokenize([task.id, task.title, ...task.changes]);
  const overlap = [...changeTokens].filter((token) => taskTokens.has(token));
  const denominator = Math.max(1, Math.min(changeTokens.size, taskTokens.size));
  const ratio = overlap.length / denominator;

  if (ratio < 0.25) {
    return undefined;
  }

  return {
    change: change.id,
    task: task.id,
    confidence: ratio >= 0.5 ? "high" : ratio >= 0.34 ? "medium" : "low",
    reason: `similar text: ${overlap.slice(0, 3).join(", ")}`,
    score: ratio >= 0.5 ? 2 : ratio >= 0.34 ? 1.5 : 1
  };
}

function commonSpecs(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((spec) => rightSet.has(spec));
}

function tokenize(values: string[]): Set<string> {
  const stopWords = new Set(["add", "change", "changes", "command", "mode", "phase", "task", "the", "to"]);
  return new Set(
    values
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !stopWords.has(token))
  );
}

function originalIdFromArchiveId(id: string): string | undefined {
  const lastSegmentStart = id.lastIndexOf("/") + 1;
  const prefix = id.slice(0, lastSegmentStart);
  const name = id.slice(lastSegmentStart);
  const match = name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return match ? `${prefix}${match[1]}` : undefined;
}

function inferPhaseStatus(tasks: SpecMartenTask[]): SpecMartenPhase["status"] {
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) {
    return "done";
  }

  return tasks.some((task) => task.status === "done" || task.status === "in-progress") ? "in-progress" : "planned";
}

function latestArchivedAt(changes: ChangeMeta[]): string | undefined {
  return changes
    .map((change) => change.archivedAt)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => b.localeCompare(a))[0];
}

function withoutUpdatedAt(state: SpecMartenState): SpecMartenState {
  return {
    ...state,
    updatedAt: ""
  };
}
