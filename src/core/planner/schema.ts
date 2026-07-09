import { z } from "zod";
import { normalizePhaseStatusValue, normalizeTaskStatusValue, phaseStatusSchema, taskStatusSchema } from "../state/schema.js";

const planTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.preprocess(normalizeTaskStatusValue, taskStatusSchema.default("todo")),
  changes: z.array(z.string()).default([]),
  archivedAt: z.string().optional(),
  source: z.string().optional()
});

const planPhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.preprocess(normalizePhaseStatusValue, phaseStatusSchema.default("planned")),
  tasks: z.array(planTaskSchema).default([])
});

const planTrackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  phases: z.array(planPhaseSchema).default([])
});

// A plan stream mirrors the state Stream shape: versioned line that may supersede
// another stream and carry either direct phases or parallel tracks. state defaults
// to "active" when omitted so a forward-looking plan still validates leniently.
const planStreamSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    label: z.string().min(1),
    state: z.enum(["maintained", "active", "planned"]).default("active"),
    supersedes: z.string().min(1).optional(),
    phases: z.array(planPhaseSchema).optional(),
    tracks: z.array(planTrackSchema).optional()
  })
  .transform((stream) => (stream.phases || stream.tracks ? stream : { ...stream, phases: [] }));

const planAgentResponseShape = {
  mission: z.string().default(""),
  currentVersion: z.string().optional(),
  streams: z.array(planStreamSchema).optional(),
  phases: z.array(planPhaseSchema).default([]),
  questions: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([])
};

// Always-required fields. streams/currentVersion/phases are intentionally optional:
// the model may emit a stream-aware roadmap OR the legacy flat phases shape.
const planAgentResponseRequired = ["mission", "questions", "notes"] as const;

export const planAgentResponseSchema = z.object(planAgentResponseShape);

export type PlanAgentResponse = z.infer<typeof planAgentResponseSchema>;
export type PlanStream = z.infer<typeof planStreamSchema>;

const taskItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: [...taskStatusSchema.options] },
    changes: { type: "array", items: { type: "string" } },
    archivedAt: { type: "string" },
    source: { type: "string" }
  },
  required: ["id", "title", "changes"]
});

const phaseItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: [...phaseStatusSchema.options] },
    tasks: { type: "array", items: taskItemSchema() }
  },
  required: ["id", "title", "tasks"]
});

const trackItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  description: "Parallel track of phases inside a stream.",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    phases: { type: "array", items: phaseItemSchema() }
  },
  required: ["id", "label", "phases"]
});

const streamItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  description:
    "Versioned roadmap line. For a large new direction, choose supersedes by default or parallel explicitly through tracks/concurrent streams; legacy top-level phases are still accepted.",
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    label: { type: "string" },
    state: { type: "string", enum: ["maintained", "active", "planned"] },
    supersedes: { type: "string", description: "id of the stream this one replaces." },
    phases: { type: "array", items: phaseItemSchema() },
    tracks: { type: "array", items: trackItemSchema() }
  },
  required: ["id", "version", "label", "state"]
});

export function planOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    description:
      "Emit currentVersion + streams[] for a stream-aware roadmap. For a large new direction, choose supersedes by default or parallel explicitly. Legacy top-level phases[] is still accepted and wrapped into a single active stream.",
    properties: {
      mission: {
        type: "string",
        description: "Short mission summary, or keep existing/empty if unclear."
      },
      currentVersion: {
        type: "string",
        description: "The stream id/version that is the current focus (e.g. \"v2\"). Optional for legacy phases output."
      },
      streams: {
        type: "array",
        description:
          "Versioned streams. Use supersedes to retire an older stream by default; use parallel tracks or concurrent streams only for genuinely concurrent work.",
        items: streamItemSchema()
      },
      phases: {
        type: "array",
        description: "Legacy flat phases. Still accepted; wrapped into a single active stream when streams is absent.",
        items: phaseItemSchema()
      },
      questions: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } }
    },
    required: [...planAgentResponseRequired]
  };
}
