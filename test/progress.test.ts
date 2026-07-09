import { describe, expect, it } from "vitest";
import {
  collectInProgressChanges,
  collectStateTasks,
  derivePhaseProgress,
  derivePhaseStatus,
  deriveStateProgress,
  deriveStreamProgress,
  deriveTrackProgress,
  findCurrentStream
} from "../src/core/progress/progress.js";
import type { SpecMartenState } from "../src/core/state/schema.js";

describe("progress aggregation", () => {
  it("rolls progress up through direct phases, tracks, streams, and whole state", () => {
    const state = stateWithDirectAndTrackedStreams();
    const directStream = state.streams[0]!;
    const trackedStream = state.streams[1]!;
    const frontendTrack = trackedStream.tracks![0]!;

    expect(deriveStreamProgress(directStream)).toEqual({
      done: 1,
      inProgress: 0,
      todo: 0,
      total: 1,
      progressPercent: 100
    });
    expect(deriveTrackProgress(frontendTrack)).toEqual({
      done: 1,
      inProgress: 1,
      todo: 1,
      total: 3,
      progressPercent: 33
    });
    expect(deriveStreamProgress(trackedStream)).toEqual({
      done: 2,
      inProgress: 1,
      todo: 1,
      total: 4,
      progressPercent: 50
    });
    expect(deriveStateProgress(state)).toEqual({
      done: 3,
      inProgress: 1,
      todo: 1,
      total: 5,
      progressPercent: 60
    });
    expect(findCurrentStream(state)).toBe(trackedStream);
    expect(collectInProgressChanges(collectStateTasks(state))).toEqual(["stream-progress-aggregation"]);
  });

  it("derives phase display status from task counts", () => {
    const done = derivePhaseProgress({
      id: "p1",
      title: "Done",
      status: "planned",
      tasks: [{ id: "p1.1", title: "Archive", status: "done", changes: [] }]
    });
    const active = derivePhaseProgress({
      id: "p2",
      title: "Active",
      status: "planned",
      tasks: [
        { id: "p2.1", title: "Build", status: "done", changes: [] },
        { id: "p2.2", title: "Wire", status: "todo", changes: [] }
      ]
    });
    const planned = derivePhaseProgress({
      id: "p3",
      title: "Planned",
      status: "in-progress",
      tasks: [{ id: "p3.1", title: "Later", status: "todo", changes: [] }]
    });

    expect(derivePhaseStatus(done)).toBe("done");
    expect(derivePhaseStatus(active)).toBe("in-progress");
    expect(derivePhaseStatus(planned)).toBe("planned");
  });
});

function stateWithDirectAndTrackedStreams(): SpecMartenState {
  return {
    version: 2,
    updatedAt: "2026-07-01T00:00:00.000Z",
    mission: "Progress aggregation",
    currentVersion: "v2",
    unlinkedActiveChanges: [],
    unlinkedChanges: [],
    streams: [
      {
        id: "v1",
        version: "v1",
        label: "Version 1",
        state: "maintained",
        phases: [
          {
            id: "p1",
            title: "Foundation",
            status: "done",
            tasks: [{ id: "p1.1", title: "Bootstrap", status: "done", changes: ["2026-06-01-bootstrap"] }]
          }
        ]
      },
      {
        id: "v2",
        version: "v2",
        label: "Version 2",
        state: "active",
        supersedes: "v1",
        tracks: [
          {
            id: "frontend",
            label: "Frontend",
            phases: [
              {
                id: "p1",
                title: "Dashboard",
                status: "planned",
                tasks: [
                  { id: "p1.1", title: "Extract helper", status: "done", changes: [] },
                  {
                    id: "p1.2",
                    title: "Wire status",
                    status: "in-progress",
                    changes: ["stream-progress-aggregation"]
                  },
                  { id: "p1.3", title: "Polish", status: "todo", changes: [] }
                ]
              }
            ]
          },
          {
            id: "backend",
            label: "Backend",
            phases: [
              {
                id: "p1",
                title: "Aggregation",
                status: "planned",
                tasks: [{ id: "p1.1", title: "Count streams", status: "done", changes: [] }]
              }
            ]
          }
        ]
      }
    ]
  };
}
