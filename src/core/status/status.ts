import { join } from "node:path";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import type { SpecMartenConfig } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { listFilePathsRecursive, readText } from "../../util/fs.js";
import { readMaintainMarker } from "../maintenance/marker.js";
import {
  hasDeterministicReconcileChanges,
  hasNewUnlinkedChanges,
  reconcileKnownLinks,
  suggestLinksForUnlinkedChanges,
  type SuggestedChangeLink
} from "../maintenance/reconcile.js";
import { runTriage, type TriageResult } from "../overseer/triage.js";
import {
  collectInProgressChanges,
  collectStateTasks,
  collectStreamPhases,
  collectStreamTasks,
  derivePhaseProgress,
  derivePhaseStatus,
  deriveStateProgress,
  deriveStreamProgress,
  findCurrentStream
} from "../progress/progress.js";
import { readState } from "../state/store.js";
import type { SpecMartenPhase, SpecMartenState, SpecMartenStream } from "../state/schema.js";

export interface StatusOptions {
  root: string;
  backend: SpecBackend;
  config: SpecMartenConfig;
}

export interface StatusMaintainSignal {
  changed: boolean;
  earlyExit: boolean;
  backendMissing: boolean;
  triage: TriageResult;
  agentCalled: false;
  rendered: false;
  markerChanged: boolean;
  needsAgent: boolean;
  needsReconcile: boolean;
  activeChanges: string[];
  unlinkedActiveChanges: string[];
  unlinkedChanges: string[];
  suggestedLinks: SuggestedChangeLink[];
  recommendedCommand: string | null;
  exitCode: 0;
}

export interface StatusStreamProgress {
  id: string;
  version: string;
  label: string;
  state: SpecMartenStream["state"];
  doneTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  totalTasks: number;
  progressPercent: number;
  inProgressChanges: string[];
}

export interface StatusDriftSummary {
  lastPatrol: string;
  warnCount: number;
  blockCount: number;
}

export interface StatusSnapshot {
  state: SpecMartenState;
  maintain: StatusMaintainSignal;
  currentPhase: string;
  currentStream: StatusStreamProgress | null;
  streams: StatusStreamProgress[];
  doneTasks: number;
  totalTasks: number;
  progressPercent: number;
  inProgressChanges: string[];
  lastPatrol: string;
  warnCount: number;
  blockCount: number;
  drift: StatusDriftSummary;
}

export interface SerializedStatusMaintainSignal extends Omit<StatusMaintainSignal, "triage"> {
  triage: Omit<TriageResult, "diffText">;
}

export interface StatusSummaryJson {
  progress: {
    doneTasks: number;
    totalTasks: number;
    progressPercent: number;
  };
  activeChanges: string[];
  unlinkedActiveChanges: string[];
  unlinkedChanges: string[];
  needsAgent: boolean;
  needsReconcile: boolean;
  recommendedCommand: string | null;
  changedFiles: string[];
  reasons: string[];
  suggestedLinks: SuggestedChangeLink[];
}

export async function runStatus(options: StatusOptions): Promise<StatusSnapshot> {
  const state = await readState(options.root);
  const maintain = await assessMaintainNeed(options, state);
  const phases = state.streams.flatMap(collectStreamPhases);
  const stateCounts = deriveStateProgress(state);
  const streams = state.streams.map(summarizeStreamProgress);
  const current = findCurrentStream(state);
  const patrolCounts = await countPatrolReports(options.root);
  const lastPatrol = state.lastPatrol ? `${state.lastPatrol.verdict} ${state.lastPatrol.change}` : "none";
  const drift = {
    lastPatrol,
    warnCount: patrolCounts.WARN,
    blockCount: patrolCounts.BLOCK
  };

  return {
    state,
    maintain,
    currentPhase: pickCurrentPhase(phases),
    currentStream: current ? summarizeStreamProgress(current) : null,
    streams,
    doneTasks: stateCounts.done,
    totalTasks: stateCounts.total,
    progressPercent: stateCounts.progressPercent,
    inProgressChanges: collectInProgressChanges(collectStateTasks(state)),
    lastPatrol,
    warnCount: patrolCounts.WARN,
    blockCount: patrolCounts.BLOCK,
    drift
  };
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const draft = snapshot.state.draft ? ` (${snapshot.state.draftKind ?? "draft"} draft)` : "";
  const lines = [
    `${TOOL.displayName} Status${draft}`,
    `Mission: ${snapshot.state.mission || "[TODO: mission summary]"}`,
    `Current phase: ${snapshot.currentPhase}`,
    `Progress: ${snapshot.doneTasks}/${snapshot.totalTasks} (${snapshot.progressPercent}%)`,
    `Current stream: ${formatCurrentStream(snapshot.currentStream)}`,
    `Streams: ${formatStreams(snapshot.streams)}`,
    `In-progress changes: ${snapshot.inProgressChanges.length ? snapshot.inProgressChanges.join(", ") : "none"}`,
    `Last patrol: ${snapshot.lastPatrol}`,
    `Open WARN/BLOCK reports: ${snapshot.warnCount}/${snapshot.blockCount}`,
    `Maintenance signal: ${formatMaintainSignal(snapshot.maintain)}`
  ];
  if (snapshot.maintain.recommendedCommand) {
    lines.push(`Next: ${snapshot.maintain.recommendedCommand}`);
  }
  if (snapshot.maintain.unlinkedActiveChanges.length > 0) {
    lines.push(`Unlinked active changes: ${snapshot.maintain.unlinkedActiveChanges.join(", ")}`);
  }
  if (snapshot.maintain.unlinkedChanges.length > 0) {
    lines.push(`Unlinked archived changes: ${snapshot.maintain.unlinkedChanges.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function serializeStatusMaintainSignal(signal: StatusMaintainSignal): SerializedStatusMaintainSignal {
  return {
    ...signal,
    triage: {
      hit: signal.triage.hit,
      changedFiles: signal.triage.changedFiles,
      reasons: signal.triage.reasons
    }
  };
}

export function statusSummaryJson(snapshot: StatusSnapshot): StatusSummaryJson {
  return {
    progress: {
      doneTasks: snapshot.doneTasks,
      totalTasks: snapshot.totalTasks,
      progressPercent: snapshot.progressPercent
    },
    activeChanges: snapshot.maintain.activeChanges,
    unlinkedActiveChanges: snapshot.maintain.unlinkedActiveChanges,
    unlinkedChanges: snapshot.maintain.unlinkedChanges,
    needsAgent: snapshot.maintain.needsAgent,
    needsReconcile: snapshot.maintain.needsReconcile,
    recommendedCommand: snapshot.maintain.recommendedCommand,
    changedFiles: snapshot.maintain.triage.changedFiles,
    reasons: snapshot.maintain.triage.reasons,
    suggestedLinks: snapshot.maintain.suggestedLinks
  };
}

async function assessMaintainNeed(options: StatusOptions, state: SpecMartenState): Promise<StatusMaintainSignal> {
  const emptyTriage: TriageResult = { hit: false, changedFiles: [], diffText: "", reasons: [] };

  if (!(await options.backend.isPresent())) {
    return {
      changed: false,
      earlyExit: false,
      backendMissing: true,
      triage: emptyTriage,
      agentCalled: false,
      rendered: false,
      markerChanged: false,
      needsAgent: false,
      needsReconcile: false,
      activeChanges: [],
      unlinkedActiveChanges: state.unlinkedActiveChanges,
      unlinkedChanges: state.unlinkedChanges,
      suggestedLinks: [],
      recommendedCommand:
        options.config.specBackend === "native" ? `${TOOL.cliName} init --backend native` : `${TOOL.cliName} init --bootstrap`,
      exitCode: 0
    };
  }

  const currentMarker = await options.backend.getCurrentMarker();
  const previousMarker = await readMaintainMarker(options.root);
  const markerChanged = previousMarker === undefined || previousMarker !== currentMarker;
  const [activeChanges, archivedChanges] = await Promise.all([
    options.backend.listActiveChanges(),
    options.backend.listArchivedChanges()
  ]);
  const reconciled = reconcileKnownLinks(state, activeChanges, archivedChanges);
  const reconcileChanged = hasDeterministicReconcileChanges(state, reconciled);
  const hasUnlinkedChanges = reconciled.unlinkedActiveChanges.length > 0 || reconciled.unlinkedChanges.length > 0;

  if (!markerChanged && !reconcileChanged && !hasUnlinkedChanges) {
    return {
      changed: false,
      earlyExit: true,
      backendMissing: false,
      triage: emptyTriage,
      agentCalled: false,
      rendered: false,
      markerChanged,
      needsAgent: false,
      needsReconcile: false,
      activeChanges: activeChanges.map((change) => change.id),
      unlinkedActiveChanges: reconciled.unlinkedActiveChanges,
      unlinkedChanges: reconciled.unlinkedChanges,
      suggestedLinks: [],
      recommendedCommand: null,
      exitCode: 0
    };
  }

  const triage = await runTriage(options.root, options.config.overseer);
  const needsAgent = triage.hit || hasUnlinkedChanges || hasNewUnlinkedChanges(state, reconciled);
  const baselineDrift = state.baseline ? (await options.backend.getSpecsHash()) !== state.baseline.specsHash : false;
  const suggestedLinks = suggestLinksForUnlinkedChanges(reconciled, [...activeChanges, ...archivedChanges]);

  return {
    changed: true,
    earlyExit: false,
    backendMissing: false,
    triage,
    agentCalled: false,
    rendered: false,
    markerChanged,
    needsAgent,
    needsReconcile: !needsAgent,
    activeChanges: activeChanges.map((change) => change.id),
    unlinkedActiveChanges: reconciled.unlinkedActiveChanges,
    unlinkedChanges: reconciled.unlinkedChanges,
    suggestedLinks,
    recommendedCommand: needsAgent ? "$specmarten-maintain" : baselineDrift ? "specmarten closeout" : "specmarten maintain",
    exitCode: 0
  };
}

function formatMaintainSignal(signal: StatusMaintainSignal): string {
  if (signal.backendMissing) {
    return "configured backend missing";
  }

  if (signal.earlyExit) {
    return "no changes";
  }

  return signal.needsAgent ? "semantic maintenance needed" : "reconcile needed";
}

function pickCurrentPhase(phases: SpecMartenPhase[]): string {
  return (
    phases.find((phase) => derivePhaseStatus(derivePhaseProgress(phase)) === "in-progress")?.title ??
    phases.find((phase) => derivePhaseStatus(derivePhaseProgress(phase)) === "planned")?.title ??
    phases.at(-1)?.title ??
    "none"
  );
}

function summarizeStreamProgress(stream: SpecMartenStream): StatusStreamProgress {
  const counts = deriveStreamProgress(stream);
  return {
    id: stream.id,
    version: stream.version,
    label: stream.label,
    state: stream.state,
    doneTasks: counts.done,
    inProgressTasks: counts.inProgress,
    todoTasks: counts.todo,
    totalTasks: counts.total,
    progressPercent: counts.progressPercent,
    inProgressChanges: collectInProgressChanges(collectStreamTasks(stream))
  };
}

function formatCurrentStream(stream: StatusStreamProgress | null): string {
  return stream ? formatStreamProgress(stream) : "none";
}

function formatStreams(streams: StatusStreamProgress[]): string {
  return streams.length > 0 ? streams.map(formatStreamProgress).join("; ") : "none";
}

function formatStreamProgress(stream: StatusStreamProgress): string {
  return `${stream.version} · ${stream.label} · ${stream.state} · ${stream.doneTasks}/${stream.totalTasks} (${stream.progressPercent}%)`;
}

async function countPatrolReports(root: string): Promise<{ WARN: number; BLOCK: number }> {
  const reportFiles = await listFilePathsRecursive(join(root, TOOL.dataDir, "reports"));
  const counts = { WARN: 0, BLOCK: 0 };

  for (const file of reportFiles.filter((path) => path.endsWith(".md"))) {
    const content = await readText(file);
    const verdict = content.match(/^verdict:\s*(PASS|WARN|BLOCK)\s*$/m)?.[1];
    if (verdict === "WARN" || verdict === "BLOCK") {
      counts[verdict] += 1;
    }
  }

  return counts;
}
