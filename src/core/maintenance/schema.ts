import { z } from "zod";
import {
  phaseStatusSchema,
  normalizePhaseStatusValue,
  normalizeTaskStatusValue,
  singleStreamState,
  taskStatusSchema,
  type SpecMartenPhase,
  type SpecMartenState,
  type SpecMartenStream,
  type SpecMartenTask
} from "../state/schema.js";

// The maintenance/check agent returns the semantically-updated global state, but
// it does NOT own lastPatrol/version/updatedAt — those are SpecMarten's to fill
// (lastPatrol only after the report file is written). So the agent-state schema
// deliberately omits them and is lenient about missing ids/status, then SpecMarten
// merges the trusted fields onto its own valid base state. This keeps real-LLM
// output-shape variation (objects, dropped fields, status synonyms) from crashing.

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function toIdString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    return pickString(value as Record<string, unknown>, ["change", "id", "changeId", "change_id", "title", "name"]) ?? "";
  }
  return value == null ? "" : String(value);
}

function toDetailString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const id = pickString(obj, ["change", "id", "changeId", "title", "name"]);
    const reason = pickString(obj, ["reason", "note", "message", "detail", "why"]);
    if (id && reason) return `${id}: ${reason}`;
    return id ?? reason ?? JSON.stringify(obj);
  }
  return value == null ? "" : String(value);
}

const asArray = (value: unknown): unknown[] => (value == null ? [] : Array.isArray(value) ? value : [value]);

const idList = z
  .preprocess(asArray, z.array(z.any()))
  .transform((arr) => arr.map(toIdString).filter((item) => item.length > 0));

const detailList = z
  .preprocess(asArray, z.array(z.any()))
  .transform((arr) => arr.map(toDetailString).filter((item) => item.length > 0));

const agentTaskStatus = z.preprocess((value) => {
  const canon = normalizeTaskStatusValue(value);
  return canon === "planned" ? "todo" : canon; // tasks have no "planned"
}, taskStatusSchema.optional());

const agentPhaseStatus = z.preprocess((value) => {
  const canon = normalizePhaseStatusValue(value);
  return canon === "todo" ? "planned" : canon; // phases have no "todo"
}, phaseStatusSchema.optional());

const agentTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).catch("Untitled task"),
  status: agentTaskStatus,
  changes: z.array(z.string()).catch([]),
  archivedAt: z.string().optional(),
  source: z.string().optional()
});

const agentPhaseSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).catch("Untitled phase"),
  status: agentPhaseStatus,
  tasks: z.array(agentTaskSchema).catch([])
});

const labelAlias = (value: unknown): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  return {
    ...obj,
    label: pickString(obj, ["label", "title", "name"])
  };
};

const agentTrackSchema = z.preprocess(
  labelAlias,
  z.object({
    id: z.string().optional(),
    label: z.string().min(1).catch("Untitled track"),
    phases: z.array(agentPhaseSchema).catch([])
  })
);

const agentStreamSchema = z.preprocess(
  labelAlias,
  z.object({
    id: z.string().optional(),
    version: z.string().optional(),
    label: z.string().min(1).catch("Untitled stream"),
    state: z.enum(["maintained", "active", "planned"]).catch("active"),
    supersedes: z.string().optional(),
    phases: z.array(agentPhaseSchema).optional(),
    tracks: z.array(agentTrackSchema).optional()
  })
);

// Unknown keys (e.g. an incomplete `lastPatrol` the agent may echo back) are
// stripped by zod's default object behaviour — they never reach validation.
export const agentStateSchema = z.object({
  mission: z.string().optional(),
  currentVersion: z.string().optional(),
  streams: z.array(agentStreamSchema).optional(),
  phases: z.array(agentPhaseSchema).optional(),
  unlinkedActiveChanges: idList.optional(),
  unlinkedChanges: idList.optional()
});

export const maintainAgentResponseSchema = z.object({
  state: agentStateSchema.optional(),
  patrol: z
    .object({
      change: z.string().optional(),
      report: z.string().min(1)
    })
    .optional(),
  notes: detailList.default([])
});

export type AgentState = z.infer<typeof agentStateSchema>;
export type AgentPhase = z.infer<typeof agentPhaseSchema>;
export type AgentStream = z.infer<typeof agentStreamSchema>;
export type MaintainAgentResponse = z.infer<typeof maintainAgentResponseSchema>;

export function normalizeAgentPhases(phases: AgentPhase[] | undefined): SpecMartenPhase[] {
  return (phases ?? []).map((phase, phaseIndex) => {
    const tasks: SpecMartenTask[] = (phase.tasks ?? []).map((task, taskIndex) => ({
      id: task.id?.trim() || `p${phaseIndex + 1}.${taskIndex + 1}`,
      title: task.title,
      status: task.status ?? "todo",
      changes: task.changes ?? [],
      archivedAt: task.archivedAt,
      source: task.source
    }));

    return {
      id: phase.id?.trim() || `p${phaseIndex + 1}`,
      title: phase.title,
      status: phase.status ?? "planned",
      tasks
    };
  });
}

export function normalizeAgentStreams(streams: AgentStream[] | undefined): SpecMartenStream[] {
  return (streams ?? []).map((stream, streamIndex) => {
    const id = stream.id?.trim() || stream.version?.trim() || `v${streamIndex + 1}`;
    const version = stream.version?.trim() || id;
    const result: SpecMartenStream = {
      id,
      version,
      label: stream.label,
      state: stream.state
    };

    if (stream.supersedes?.trim()) {
      result.supersedes = stream.supersedes.trim();
    }

    const tracks = (stream.tracks ?? []).map((track, trackIndex) => ({
      id: track.id?.trim() || `${id}-track-${trackIndex + 1}`,
      label: track.label,
      phases: normalizeAgentPhases(track.phases)
    }));
    if (tracks.length > 0) {
      result.tracks = tracks;
    } else {
      result.phases = normalizeAgentPhases(stream.phases);
    }

    return result;
  });
}

// Overlay the agent's trusted fields (mission/phases/unlinkedChanges) onto a valid
// base state. version/updatedAt/lastPatrol/baseline/draft stay SpecMarten-owned.
export function mergeAgentState(base: SpecMartenState, agent: AgentState): SpecMartenState {
  const merged = {
    ...base,
    mission: agent.mission ?? base.mission,
    unlinkedActiveChanges: agent.unlinkedActiveChanges ?? base.unlinkedActiveChanges,
    unlinkedChanges: agent.unlinkedChanges ?? base.unlinkedChanges
  };

  if (agent.streams && agent.streams.length > 0) {
    const streams = normalizeAgentStreams(agent.streams);
    return {
      ...merged,
      currentVersion: agent.currentVersion ?? base.currentVersion ?? streams[0]?.version ?? "",
      streams
    };
  }

  return agent.phases
    ? singleStreamState(merged, normalizeAgentPhases(agent.phases), { currentVersion: base.currentVersion || "v1" })
    : merged;
}

const taskOutputSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: {
      type: "string",
      description: "Optional task status. Canonical values are todo, in-progress, done; common synonyms are accepted by write-draft."
    },
    changes: { type: "array", items: { type: "string" } },
    archivedAt: { type: "string" },
    source: { type: "string" }
  },
  required: ["title", "changes"]
});

const phaseOutputSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: {
      type: "string",
      description: "Optional phase status. Canonical values are planned, in-progress, done; common synonyms are accepted by write-draft."
    },
    tasks: { type: "array", items: taskOutputSchema() }
  },
  required: ["title", "tasks"]
});

const trackOutputSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    phases: { type: "array", items: phaseOutputSchema() }
  },
  required: ["label", "phases"]
});

const streamOutputSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    label: { type: "string" },
    state: { type: "string", enum: ["maintained", "active", "planned"] },
    supersedes: { type: "string", description: "id of the stream this one replaces." },
    phases: { type: "array", items: phaseOutputSchema() },
    tracks: { type: "array", items: trackOutputSchema() }
  },
  required: ["label", "state"]
});

export function maintainOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      state: {
        type: "object",
        additionalProperties: false,
        properties: {
          mission: { type: "string" },
          currentVersion: {
            type: "string",
            description: "Current stream version/id when returning stream-aware maintained state."
          },
          streams: {
            type: "array",
            description:
              "Preferred maintained state shape. Preserve existing streams/tracks/supersedes; use a new stream for a large new direction.",
            items: streamOutputSchema()
          },
          phases: {
            type: "array",
            description: "Legacy single-stream maintain output. Use only when preserving a simple single-stream roadmap.",
            items: phaseOutputSchema()
          },
          unlinkedActiveChanges: { type: "array", items: { type: "string" } },
          unlinkedChanges: { type: "array", items: { type: "string" } }
        }
      },
      patrol: {
        type: "object",
        additionalProperties: false,
        properties: {
          change: { type: "string" },
          report: {
            type: "string",
            description: "Markdown report ending with VERDICT: PASS, VERDICT: WARN, or VERDICT: BLOCK."
          }
        },
        required: ["report"]
      },
      notes: { type: "array", items: { type: "string" } }
    }
  };
}
