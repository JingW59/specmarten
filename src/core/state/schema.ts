import { z } from "zod";

export const taskStatusSchema = z.enum(["todo", "in-progress", "done"]);
export const phaseStatusSchema = z.enum(["planned", "in-progress", "done"]);
export const patrolVerdictSchema = z.enum(["PASS", "WARN", "BLOCK"]);

function pickStatusValue(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return obj.status ?? obj.value ?? obj.state ?? obj.name ?? obj.label ?? raw;
  }
  return raw;
}

function canonicalStatus(raw: unknown): "done" | "in-progress" | "todo" | "planned" | unknown {
  const value = pickStatusValue(raw);
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["done", "complete", "completed", "finished", "closed", "archived", "shipped"].includes(normalized)) {
    return "done";
  }
  if (["in-progress", "inprogress", "wip", "active", "started", "doing", "ongoing"].includes(normalized)) {
    return "in-progress";
  }
  if (["planned", "plan", "upcoming", "future", "scheduled"].includes(normalized)) {
    return "planned";
  }
  if (["todo", "to-do", "pending", "not-started", "backlog", "new", "open"].includes(normalized)) {
    return "todo";
  }
  return value;
}

export function normalizeTaskStatusValue(raw: unknown): unknown {
  const status = canonicalStatus(raw);
  if (status === "done" || status === "in-progress") return status;
  return "todo";
}

export function normalizePhaseStatusValue(raw: unknown): unknown {
  const status = canonicalStatus(raw);
  if (status === "done" || status === "in-progress") return status;
  return "planned";
}

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  changes: z.array(z.string()).default([]),
  archivedAt: z.string().optional(),
  source: z.string().optional()
});

export const phaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: phaseStatusSchema,
  tasks: z.array(taskSchema).default([])
});

export const trackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  phases: z.array(phaseSchema).default([])
});

export const streamSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    label: z.string().min(1),
    state: z.enum(["maintained", "active", "planned"]),
    supersedes: z.string().min(1).optional(),
    phases: z.array(phaseSchema).optional(),
    tracks: z.array(trackSchema).optional()
  })
  .transform((stream) => (stream.phases || stream.tracks ? stream : { ...stream, phases: [] }));

export const patrolSchema = z.object({
  change: z.string(),
  verdict: patrolVerdictSchema,
  report: z.string(),
  at: z.string()
});

export const baselineSchema = z.object({
  specsHash: z.string(),
  at: z.string()
});

function normalizeStateInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const state = input as Record<string, unknown>;
  if (!Array.isArray(state.streams)) {
    return input;
  }

  return {
    ...state,
    streams: state.streams.map(normalizeStreamInput)
  };
}

function normalizeStreamInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const stream = input as Record<string, unknown>;
  const next: Record<string, unknown> = { ...stream };
  if (Array.isArray(stream.phases)) {
    next.phases = stream.phases.map(normalizePhaseInput);
  }
  if (Array.isArray(stream.tracks)) {
    next.tracks = stream.tracks.map(normalizeTrackInput);
  }
  return next;
}

function normalizeTrackInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const track = input as Record<string, unknown>;
  return {
    ...track,
    phases: Array.isArray(track.phases) ? track.phases.map(normalizePhaseInput) : []
  };
}

function normalizePhaseInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const phase = input as Record<string, unknown>;
  return {
    ...phase,
    status: normalizePhaseStatusValue(phase.status),
    tasks: Array.isArray(phase.tasks) ? phase.tasks.map(normalizeTaskInput) : []
  };
}

function normalizeTaskInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const task = input as Record<string, unknown>;
  return {
    ...task,
    status: normalizeTaskStatusValue(task.status),
    changes: Array.isArray(task.changes) ? task.changes : []
  };
}

const stateObjectSchema = z.object({
  version: z.literal(2),
  draft: z.boolean().optional(),
  draftKind: z.enum(["plan", "backfill"]).optional(),
  updatedAt: z.string(),
  mission: z.string().default(""),
  currentVersion: z.string(),
  streams: z.array(streamSchema).default([]),
  lastPatrol: patrolSchema.nullable().optional(),
  baseline: baselineSchema.nullable().optional(),
  unlinkedActiveChanges: z.array(z.string()).default([]),
  unlinkedChanges: z.array(z.string()).default([])
});

export const stateSchema = z.preprocess(normalizeStateInput, stateObjectSchema);

export type SpecMartenState = z.infer<typeof stateSchema>;
export type SpecMartenStream = z.infer<typeof streamSchema>;
export type SpecMartenTrack = z.infer<typeof trackSchema>;
export type SpecMartenPhase = z.infer<typeof phaseSchema>;
export type SpecMartenTask = z.infer<typeof taskSchema>;
export type SpecMartenBaseline = z.infer<typeof baselineSchema>;

export function collectPhases(state: SpecMartenState): SpecMartenPhase[] {
  return state.streams.flatMap((stream) => {
    const phases = stream.phases ?? [];
    const trackPhases = stream.tracks?.flatMap((track) => track.phases) ?? [];
    return [...phases, ...trackPhases];
  });
}

export function mapPhasesInState(
  state: SpecMartenState,
  mapPhase: (phase: SpecMartenPhase) => SpecMartenPhase
): SpecMartenState {
  return {
    ...state,
    streams: state.streams.map((stream) => ({
      ...stream,
      phases: stream.phases?.map(mapPhase),
      tracks: stream.tracks?.map((track) => ({
        ...track,
        phases: track.phases.map(mapPhase)
      }))
    }))
  };
}

export function singleStreamState(
  state: Omit<SpecMartenState, "currentVersion" | "streams">,
  phases: SpecMartenPhase[],
  opts: { currentVersion?: string; streamId?: string; streamLabel?: string; streamState?: SpecMartenStream["state"] } = {}
): SpecMartenState {
  const currentVersion = opts.currentVersion ?? "v1";
  const streamId = opts.streamId ?? currentVersion;
  const streamLabel = opts.streamLabel ?? currentVersion;
  return {
    ...state,
    currentVersion,
    streams: [
      {
        id: streamId,
        version: currentVersion,
        label: streamLabel,
        state: opts.streamState ?? "active",
        phases
      }
    ]
  };
}
