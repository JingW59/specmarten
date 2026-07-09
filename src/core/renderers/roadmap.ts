import { join } from "node:path";
import { GENERATED_HEADER, TOOL } from "../../constants.js";
import { writeText } from "../../util/fs.js";
import {
  type SpecMartenPhase,
  type SpecMartenState,
  type SpecMartenStream,
  type SpecMartenTask,
  type SpecMartenTrack
} from "../state/schema.js";

export function renderRoadmapMarkdown(state: SpecMartenState): string {
  const lines = [
    GENERATED_HEADER,
    "",
    "# Roadmap",
    "",
    draftBanner(state),
    state.mission ? `> ${state.mission}` : "> [TODO: mission summary]",
    "",
    `Last updated: ${state.updatedAt}`,
    ""
  ].filter((line, index, arr) => line !== "" || arr[index - 1] !== "");

  if (state.streams.length === 0) {
    lines.push("## No Phases Yet", "", "Run `specmarten plan \"...\"` to ask the AI maintainer for a draft roadmap.", "");
    return renderLines(lines);
  }

  for (const stream of state.streams) {
    lines.push(renderStream(stream), "");
  }

  if (state.unlinkedActiveChanges.length > 0 || state.unlinkedChanges.length > 0) {
    lines.push("## OpenSpec Changes Needing Roadmap Links", "");
  }

  if (state.unlinkedActiveChanges.length > 0) {
    lines.push("### Active", "");
    for (const change of state.unlinkedActiveChanges) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }

  if (state.unlinkedChanges.length > 0) {
    lines.push("### Archived", "");
    for (const change of state.unlinkedChanges) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }

  return renderLines(lines);
}

function renderLines(lines: string[]): string {
  const output = [...lines];
  while (output.at(-1) === "") {
    output.pop();
  }
  return `${output.join("\n")}\n`;
}

function draftBanner(state: SpecMartenState): string {
  if (!state.draft) {
    return "";
  }

  return state.draftKind === "backfill"
    ? "> AUTO-BACKFILLED DRAFT: review this with the AI maintainer before promoting."
    : "> AI-GENERATED DRAFT: review this with the AI maintainer before promoting.";
}

export async function writeRoadmap(root: string, state: SpecMartenState): Promise<void> {
  await writeText(join(root, TOOL.dataDir, "roadmap.md"), renderRoadmapMarkdown(state));
}

function renderStream(stream: SpecMartenStream): string {
  const lines = [`## ${stream.version} · ${stream.label}`, "", `State: ${stream.state}`];

  if (stream.supersedes) {
    lines.push(`Supersedes: ${stream.supersedes}`);
  }

  lines.push("");

  const phases = stream.phases ?? [];
  const tracks = stream.tracks ?? [];
  if (phases.length === 0 && tracks.length === 0) {
    lines.push("_No phases yet._");
    return lines.join("\n");
  }

  for (const phase of phases) {
    lines.push(renderPhase(phase, 3), "");
  }

  for (const track of tracks) {
    lines.push(renderTrack(track), "");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function renderTrack(track: SpecMartenTrack): string {
  const lines = [`### ${track.label}`, ""];

  if (track.phases.length === 0) {
    lines.push("_No phases yet._");
    return lines.join("\n");
  }

  for (const phase of track.phases) {
    lines.push(renderPhase(phase, 4), "");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function renderPhase(phase: SpecMartenPhase, headingLevel: 3 | 4): string {
  const heading = "#".repeat(headingLevel);
  const lines = [`${heading} ${phase.title}`, "", `Status: ${phase.status}`, ""];

  for (const task of phase.tasks) {
    lines.push(renderTask(task));
  }

  return lines.join("\n");
}

function renderTask(task: SpecMartenTask): string {
  const marker = task.status === "done" ? "[x]" : task.status === "in-progress" ? "[~]" : "[ ]";
  const changes = task.changes.length > 0 ? ` (${task.changes.map((change) => `\`${change}\``).join(", ")})` : "";
  return `- ${marker} ${task.title}${changes}`;
}
