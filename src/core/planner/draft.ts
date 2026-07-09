import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { writeText } from "../../util/fs.js";
import { renderViews } from "../renderers/index.js";
import { collectPhases, singleStreamState, type SpecMartenState, type SpecMartenStream } from "../state/schema.js";
import { writeState } from "../state/store.js";
import { readExistingOrInitial } from "./input.js";
import type { PlanAgentResponse, PlanStream } from "./schema.js";

export interface PlanDraftWriteOptions {
  root: string;
  response: PlanAgentResponse;
  requirement?: string | null;
}

export interface PlanDraftSummary {
  statePath: string;
  reportPath: string;
  phases: number;
  tasks: number;
  questions: string[];
}

export function createPlanDraftState(current: SpecMartenState, response: PlanAgentResponse): SpecMartenState {
  const base = {
    ...current,
    draft: true as const,
    draftKind: "plan" as const,
    updatedAt: new Date().toISOString(),
    mission: response.mission || current.mission,
    unlinkedChanges: current.unlinkedChanges
  };

  // Stream-aware plan output: preserve every stream/track/supersedes/currentVersion
  // instead of flattening into a single stream.
  if (response.streams && response.streams.length > 0) {
    const currentVersion =
      response.currentVersion || current.currentVersion || response.streams[0]?.version || "v1";
    return {
      ...base,
      currentVersion,
      streams: response.streams.map(toStateStream)
    };
  }

  // Legacy flat phases output: wrap into a single active stream.
  return singleStreamState(base, response.phases, { currentVersion: current.currentVersion || "v1" });
}

function toStateStream(stream: PlanStream): SpecMartenStream {
  const result: SpecMartenStream = {
    id: stream.id,
    version: stream.version,
    label: stream.label,
    state: stream.state
  };
  if (stream.supersedes) {
    result.supersedes = stream.supersedes;
  }
  if (stream.tracks && stream.tracks.length > 0) {
    result.tracks = stream.tracks.map((track) => ({
      id: track.id,
      label: track.label,
      phases: track.phases
    }));
  }
  if (stream.phases && stream.phases.length > 0) {
    result.phases = stream.phases;
  }
  if (!result.phases && !result.tracks) {
    result.phases = [];
  }
  return result;
}

export async function writePlanDraft(options: PlanDraftWriteOptions): Promise<PlanDraftSummary> {
  const currentState = await readExistingOrInitial(options.root);
  const draft = createPlanDraftState(currentState, options.response);
  await writeState(options.root, draft);
  await renderViews(options.root, draft);

  const reportPath = join(options.root, TOOL.dataDir, "plan-report.md");
  await writeText(reportPath, renderPlanReport(options.requirement, options.response));

  const phases = collectPhases(draft);
  return {
    statePath: join(options.root, TOOL.dataDir, "state.json"),
    reportPath,
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    questions: options.response.questions
  };
}

export function renderPlanReport(requirement: string | null | undefined, response: PlanAgentResponse): string {
  const lines = [
    "# Plan Report",
    "",
    `Requirement: ${requirement?.trim() || "not provided"}`,
    "",
    "## Questions",
    "",
    ...(response.questions.length ? response.questions.map((question) => `- ${question}`) : ["- none"]),
    "",
    "## Notes",
    "",
    ...(response.notes.length ? response.notes.map((note) => `- ${note}`) : ["- none"])
  ];

  return `${lines.join("\n")}\n`;
}
