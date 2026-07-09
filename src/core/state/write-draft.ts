import { backfillAgentResponseSchema, type BackfillAgentResponse } from "../backfill/schema.js";
import { maintainAgentResponseSchema, type MaintainAgentResponse } from "../maintenance/schema.js";
import { planAgentResponseSchema, type PlanAgentResponse } from "../planner/schema.js";
import { stateSchema, type SpecMartenState } from "./schema.js";

export type DraftKind = "plan" | "backfill" | "maintain";

export interface DraftIssue {
  path: Array<string | number>;
  code?: string;
  message: string;
}

export interface DraftInputErrorBody {
  error: "invalid_draft_json" | "invalid_draft_schema";
  kind: DraftKind;
  message: string;
  issues: DraftIssue[];
}

export class DraftInputError extends Error {
  readonly body: DraftInputErrorBody;
  readonly exitCode = 1;

  constructor(body: DraftInputErrorBody) {
    super(body.message);
    this.name = "DraftInputError";
    this.body = body;
  }
}

export function parsePlanDraftJson(input: string): PlanAgentResponse {
  return parseDraftJson(input, "plan", planAgentResponseSchema, "Draft JSON does not match the plan output schema.");
}

export function parseBackfillDraftJson(input: string): BackfillAgentResponse {
  return parseDraftJson(
    input,
    "backfill",
    backfillAgentResponseSchema,
    "Draft JSON does not match the backfill output schema."
  );
}

export function parseMaintainDraftJson(input: string): MaintainAgentResponse {
  return parseDraftJson(
    input,
    "maintain",
    maintainAgentResponseSchema,
    "Draft JSON does not match the maintain output schema."
  );
}

export function parseStateDraftJsonIfPresent(input: string, kind: DraftKind): SpecMartenState | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new DraftInputError({
      error: "invalid_draft_json",
      kind,
      message: "Draft input is not valid JSON.",
      issues: [
        {
          path: [],
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    });
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  // Only an explicit version 2 submission is treated as a full v2 state. A
  // stream-aware plan/backfill response also carries `streams` but is NOT a full
  // state (it has questions/notes/lowConfidence and no updatedAt), so it must
  // fall through to the kind-specific parser that preserves streams and reports
  // the relevant errors.
  if (record.version !== 2) {
    return null;
  }

  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    throw new DraftInputError({
      error: "invalid_draft_schema",
      kind,
      message: "Draft JSON does not match the v2 state schema.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message
      }))
    });
  }

  return {
    ...parsed.data,
    draft: kind === "maintain" ? parsed.data.draft : true,
    draftKind: kind === "maintain" ? parsed.data.draftKind : kind
  };
}

function parseDraftJson<T>(
  input: string,
  kind: DraftKind,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: DraftIssue[] } } },
  schemaMessage: string
): T {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new DraftInputError({
      error: "invalid_draft_json",
      kind,
      message: "Draft input is not valid JSON.",
      issues: [
        {
          path: [],
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    });
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DraftInputError({
      error: "invalid_draft_schema",
      kind,
      message: schemaMessage,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message
      }))
    });
  }

  return parsed.data;
}

export function formatDraftInputError(error: DraftInputError): string {
  return JSON.stringify(error.body, null, 2);
}
