import type { SpecMartenPhase, SpecMartenState, SpecMartenStream, SpecMartenTask, SpecMartenTrack } from "../state/schema.js";

export interface ProgressCounts {
  done: number;
  inProgress: number;
  todo: number;
  total: number;
  progressPercent: number;
}

export const EMPTY_PROGRESS_COUNTS: ProgressCounts = {
  done: 0,
  inProgress: 0,
  todo: 0,
  total: 0,
  progressPercent: 0
};

export function deriveTaskProgress(tasks: SpecMartenTask[]): ProgressCounts {
  let done = 0;
  let inProgress = 0;
  let todo = 0;

  for (const task of tasks) {
    if (task.status === "done") done += 1;
    else if (task.status === "in-progress") inProgress += 1;
    else todo += 1;
  }

  return progressCounts(done, inProgress, todo);
}

export function derivePhaseProgress(phase: SpecMartenPhase): ProgressCounts {
  return deriveTaskProgress(phase.tasks);
}

export function deriveTrackProgress(track: SpecMartenTrack): ProgressCounts {
  return deriveTaskProgress(collectTrackTasks(track));
}

export function deriveStreamProgress(stream: SpecMartenStream): ProgressCounts {
  return deriveTaskProgress(collectStreamTasks(stream));
}

export function deriveStateProgress(state: SpecMartenState): ProgressCounts {
  return deriveTaskProgress(collectStateTasks(state));
}

export function derivePhaseStatus(counts: ProgressCounts): SpecMartenPhase["status"] {
  if (counts.total > 0 && counts.done === counts.total) return "done";
  if (counts.done > 0 || counts.inProgress > 0) return "in-progress";
  return "planned";
}

export function collectStreamPhases(stream: SpecMartenStream): SpecMartenPhase[] {
  const direct = stream.phases ?? [];
  const trackPhases = stream.tracks?.flatMap((track) => track.phases) ?? [];
  return [...direct, ...trackPhases];
}

export function collectTrackTasks(track: SpecMartenTrack): SpecMartenTask[] {
  return track.phases.flatMap((phase) => phase.tasks);
}

export function collectStreamTasks(stream: SpecMartenStream): SpecMartenTask[] {
  return collectStreamPhases(stream).flatMap((phase) => phase.tasks);
}

export function collectStateTasks(state: SpecMartenState): SpecMartenTask[] {
  return state.streams.flatMap(collectStreamTasks);
}

export function collectInProgressChanges(tasks: SpecMartenTask[]): string[] {
  return tasks
    .filter((task) => task.status === "in-progress")
    .flatMap((task) => task.changes)
    .filter((change, index, all) => all.indexOf(change) === index)
    .sort((a, b) => a.localeCompare(b));
}

export function findCurrentStream(state: SpecMartenState): SpecMartenStream | undefined {
  return state.streams.find((stream) => stream.version === state.currentVersion) ?? state.streams.at(-1);
}

function progressCounts(done: number, inProgress: number, todo: number): ProgressCounts {
  const total = done + inProgress + todo;
  return {
    done,
    inProgress,
    todo,
    total,
    progressPercent: total === 0 ? 0 : Math.round((done / total) * 100)
  };
}
