import { z } from "zod";

// Real LLMs (codex, GLM, ...) don't always return the exact shapes we ask for:
// arrays may contain objects ({change, reason}) instead of strings, or fields may
// be missing. These schemas are deliberately LENIENT + NORMALIZING so a small
// output-shape variation never crashes backfill. Normalization collapses every
// element to a plain string so all downstream consumers keep working unchanged.

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

function withLabelAlias(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.label === "string" && obj.label.trim()) {
    return value;
  }
  const title = obj.title;
  if (typeof title === "string" && title.trim()) {
    return { ...obj, label: title.trim() };
  }
  return value;
}

const idList = z
  .preprocess(asArray, z.array(z.any()))
  .transform((arr) => arr.map(toIdString).filter((item) => item.length > 0));

const detailList = z
  .preprocess(asArray, z.array(z.any()))
  .transform((arr) => arr.map(toDetailString).filter((item) => item.length > 0));

export const backfillTaskProposalSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).catch("Untitled task"),
  changes: idList,
  source: z.string().optional()
});

export const backfillPhaseProposalSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).catch("Untitled phase"),
  tasks: z.array(backfillTaskProposalSchema).catch([])
});

export const backfillTrackProposalSchema = z.preprocess(
  withLabelAlias,
  z.object({
    id: z.string().min(1).optional(),
    label: z.string().min(1).catch("Untitled track"),
    phases: z.array(backfillPhaseProposalSchema).catch([])
  })
);

// A stream proposal mirrors the state Stream shape but stays lenient: id/version
// are optional (SpecMarten assigns stable ids in createDraftState) and state
// defaults to "active". A stream may carry direct phases or parallel tracks.
export const backfillStreamProposalSchema = z.preprocess(
  withLabelAlias,
  z.object({
    id: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    label: z.string().min(1).catch("Untitled stream"),
    state: z.enum(["maintained", "active", "planned"]).catch("active"),
    supersedes: z.string().min(1).optional(),
    phases: z.array(backfillPhaseProposalSchema).optional(),
    tracks: z.array(backfillTrackProposalSchema).optional()
  })
);

export const backfillAgentResponseSchema = z.object({
  mission: z.string().catch(""),
  currentVersion: z.string().optional(),
  streams: z.array(backfillStreamProposalSchema).catch([]),
  phases: z.array(backfillPhaseProposalSchema).catch([]),
  unlinkedChanges: idList,
  lowConfidence: detailList,
  superseded: idList,
  notes: detailList
});

export type BackfillAgentResponse = z.infer<typeof backfillAgentResponseSchema>;
export type BackfillStreamProposal = z.infer<typeof backfillStreamProposalSchema>;
export type BackfillTrackProposal = z.infer<typeof backfillTrackProposalSchema>;
export type BackfillPhaseProposal = z.infer<typeof backfillPhaseProposalSchema>;
export type BackfillTaskProposal = z.infer<typeof backfillTaskProposalSchema>;

const taskProposalItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Optional stable task id." },
    title: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    source: { type: "string" }
  },
  required: ["title", "changes"]
});

const phaseProposalItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Optional stable phase id." },
    title: { type: "string" },
    tasks: { type: "array", items: taskProposalItemSchema() }
  },
  required: ["title", "tasks"]
});

const trackProposalItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  description: "Parallel track of phases inside a stream.",
  properties: {
    id: { type: "string", description: "Optional stable track id." },
    label: { type: "string" },
    phases: { type: "array", items: phaseProposalItemSchema() }
  },
  required: ["label", "phases"]
});

const streamProposalItemSchema = () => ({
  type: "object",
  additionalProperties: false,
  description:
    "Versioned roadmap line reconstructed from OpenSpec history. For a large new direction, choose supersedes by default or parallel explicitly; legacy top-level phases are still accepted.",
  properties: {
    id: { type: "string", description: "Optional stream id; assigned if omitted." },
    version: { type: "string", description: "Stream version label, e.g. \"v1\"." },
    label: { type: "string" },
    state: { type: "string", enum: ["maintained", "active", "planned"] },
    supersedes: { type: "string", description: "id of the stream this one replaces." },
    phases: { type: "array", items: phaseProposalItemSchema() },
    tracks: { type: "array", items: trackProposalItemSchema() }
  },
  required: ["label"]
});

export function backfillOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    description:
      "Emit currentVersion + streams[] for a stream-aware roadmap. For a large new direction, choose supersedes by default or parallel explicitly. Legacy top-level phases[] is still accepted and wrapped into a single active stream.",
    properties: {
      mission: {
        type: "string",
        description: "Short project summary if inferable, otherwise empty."
      },
      currentVersion: {
        type: "string",
        description: "The stream id/version that is the current focus (e.g. \"v2\"). Optional for legacy phases output."
      },
      streams: {
        type: "array",
        description:
          "Versioned streams reconstructed from OpenSpec history. Use supersedes for retired streams by default; use parallel only for genuinely concurrent work.",
        items: streamProposalItemSchema()
      },
      phases: {
        type: "array",
        description: "Legacy flat phases. Still accepted; wrapped into a single active stream when streams is absent.",
        items: phaseProposalItemSchema()
      },
      unlinkedChanges: { type: "array", items: { type: "string" } },
      lowConfidence: { type: "array", items: { type: "string" } },
      superseded: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["mission", "unlinkedChanges", "lowConfidence", "superseded", "notes"]
  };
}
