import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentRunner } from "../../adapters/agent/types.js";
import type { SpecBackend, ChangeDetail } from "../../adapters/spec-backend/types.js";
import { readContentLanguage } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import type { ContentLanguage } from "../content-language.js";
import { runPromote } from "../promote/promote.js";
import { pathExists, readJson, writeJson, writeText } from "../../util/fs.js";
import { UserFacingError } from "../../util/errors.js";
import { extractJsonObject } from "../../util/json.js";
import {
  backfillAgentResponseSchema,
  type BackfillAgentResponse,
  type BackfillStreamProposal,
  type BackfillTrackProposal
} from "./schema.js";
import { buildBackfillPrompt } from "./prompt.js";
import { mergePhasesByTitle, writeBackfillDraftFromSnapshot, type BackfillSummary } from "./draft.js";
import { readBackfillSnapshot } from "./snapshot.js";
import { collectPhases } from "../state/schema.js";

export interface BackfillOptions {
  root: string;
  backend: SpecBackend;
  agent?: AgentRunner;
  groupBy?: "capability" | "time" | "flat";
  promote?: boolean;
}

const BACKFILL_BATCH_THRESHOLD = 80;
const BACKFILL_BATCH_SIZE = 40;

export async function runBackfill(options: BackfillOptions): Promise<BackfillSummary> {
  if (options.promote) {
    return promoteBackfillDraft(options.root);
  }

  if (!options.agent) {
    throw new UserFacingError("Backfill requires an available bring-your-own-agent CLI: claude, codex, or gemini.");
  }

  const snapshot = await readBackfillSnapshot(options.backend);
  const contentLanguage = await readContentLanguage(options.root);
  const { response: agentResponse, batches } = await runBackfillAgent({
    root: options.root,
    groupBy: options.groupBy ?? "capability",
    contentLanguage,
    changes: snapshot.changes,
    specs: snapshot.specs,
    agent: options.agent
  });
  return writeBackfillDraftFromSnapshot({
    root: options.root,
    backend: options.backend,
    response: agentResponse,
    snapshot,
    batches
  });
}

async function runBackfillAgent(input: {
  root: string;
  groupBy: "capability" | "time" | "flat";
  contentLanguage: ContentLanguage;
  changes: ChangeDetail[];
  specs: unknown[];
  agent: AgentRunner;
}): Promise<{ response: BackfillAgentResponse; batches: number }> {
  const batches =
    input.changes.length > BACKFILL_BATCH_THRESHOLD
      ? chunk(input.changes, BACKFILL_BATCH_SIZE)
      : [input.changes];
  const responses: BackfillAgentResponse[] = [];

  for (const batch of batches) {
    const prompt = buildBackfillPrompt({
      groupBy: input.groupBy,
      contentLanguage: input.contentLanguage,
      changes: batch,
      specs: input.specs as never
    });
    const cacheKey = backfillCacheKey({
      groupBy: input.groupBy,
      contentLanguage: input.contentLanguage,
      changes: batch,
      specs: input.specs
    });
    responses.push(
      await readOrCreateBackfillResponse(input.root, cacheKey, async () => {
        const raw = await input.agent.run(prompt, { cwd: input.root });
        try {
          return backfillAgentResponseSchema.parse(extractJsonObject(raw));
        } catch (error) {
          await writeText(
            join(input.root, TOOL.dataDir, "backfill-report.md"),
            renderBackfillFailureReport(raw, error)
          );
          throw new UserFacingError(
            `Backfill agent output could not be parsed; raw output saved to ${TOOL.dataDir}/backfill-report.md. ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );
  }

  return {
    response: mergeBackfillResponses(responses),
    batches: batches.length
  };
}

function mergeBackfillResponses(responses: BackfillAgentResponse[]): BackfillAgentResponse {
  if (responses.length === 1) {
    return responses[0]!;
  }

  const hasStreams = responses.some((response) => response.streams.length > 0);
  const legacyPhases = mergePhasesByTitle(responses.flatMap((response) => response.phases));
  const base = {
    mission: responses.find((response) => response.mission)?.mission ?? "",
    unlinkedChanges: [...new Set(responses.flatMap((response) => response.unlinkedChanges))],
    lowConfidence: [...new Set(responses.flatMap((response) => response.lowConfidence))],
    superseded: [...new Set(responses.flatMap((response) => response.superseded))],
    notes: responses.flatMap((response, index) => [`Batch ${index + 1}`, ...response.notes])
  };

  if (hasStreams) {
    const streams = mergeStreams(responses.flatMap((response) => response.streams));
    if (legacyPhases.length > 0) {
      streams.push({
        id: "legacy-batches",
        version: "legacy-batches",
        label: "Legacy batches",
        state: "active",
        phases: legacyPhases
      });
    }

    return backfillAgentResponseSchema.parse({
      ...base,
      currentVersion: responses.find((response) => response.currentVersion)?.currentVersion,
      streams,
      phases: []
    });
  }

  return backfillAgentResponseSchema.parse({
    ...base,
    phases: legacyPhases
  });
}

function mergeStreams(streams: BackfillStreamProposal[]): BackfillStreamProposal[] {
  const merged: BackfillStreamProposal[] = [];
  const byIdentity = new Map<string, BackfillStreamProposal>();

  for (const stream of streams) {
    const key = streamIdentityKey(stream);
    const existing = byIdentity.get(key);
    if (existing) {
      mergeStreamInto(existing, stream);
    } else {
      const next = cloneStream(stream);
      merged.push(next);
      byIdentity.set(key, next);
    }
  }

  return merged;
}

function mergeStreamInto(target: BackfillStreamProposal, source: BackfillStreamProposal): void {
  if (!target.supersedes && source.supersedes) {
    target.supersedes = source.supersedes;
  }

  const phases = [...(target.phases ?? []), ...(source.phases ?? [])];
  if (phases.length > 0) {
    target.phases = mergePhasesByTitle(phases);
  }

  const tracks = mergeTracks([...(target.tracks ?? []), ...(source.tracks ?? [])]);
  if (tracks.length > 0) {
    target.tracks = tracks;
  }
}

function mergeTracks(tracks: BackfillTrackProposal[]): BackfillTrackProposal[] {
  const merged: BackfillTrackProposal[] = [];
  const byIdentity = new Map<string, BackfillTrackProposal>();

  for (const track of tracks) {
    const key = trackIdentityKey(track);
    const existing = byIdentity.get(key);
    if (existing) {
      existing.phases = mergePhasesByTitle([...existing.phases, ...track.phases]);
    } else {
      const next = { ...track, phases: mergePhasesByTitle(track.phases) };
      merged.push(next);
      byIdentity.set(key, next);
    }
  }

  return merged;
}

function cloneStream(stream: BackfillStreamProposal): BackfillStreamProposal {
  const next: BackfillStreamProposal = {
    ...stream,
    phases: stream.phases ? mergePhasesByTitle(stream.phases) : undefined,
    tracks: stream.tracks ? mergeTracks(stream.tracks) : undefined
  };
  return next;
}

function streamIdentityKey(stream: BackfillStreamProposal): string {
  if (stream.id?.trim()) {
    return `id:${stream.id.trim()}`;
  }
  if (stream.version?.trim()) {
    return `version:${stream.version.trim()}`;
  }
  return `label:${normalizeIdentity(stream.label)}`;
}

function trackIdentityKey(track: BackfillTrackProposal): string {
  if (track.id?.trim()) {
    return `id:${track.id.trim()}`;
  }
  return `label:${normalizeIdentity(track.label)}`;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function readOrCreateBackfillResponse(
  root: string,
  cacheKey: string,
  create: () => Promise<BackfillAgentResponse>
): Promise<BackfillAgentResponse> {
  const cachePath = join(root, TOOL.dataDir, ".cache", "backfill", `${cacheKey}.json`);
  if (await pathExists(cachePath)) {
    return backfillAgentResponseSchema.parse(await readJson(cachePath));
  }

  const response = await create();
  await writeJson(cachePath, response);
  return response;
}

function backfillCacheKey(input: {
  groupBy: "capability" | "time" | "flat";
  contentLanguage: ContentLanguage;
  changes: ChangeDetail[];
  specs: unknown[];
}): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      groupBy: input.groupBy,
      contentLanguage: input.contentLanguage,
      changes: input.changes.map((change) => ({
        id: change.id,
        status: change.status,
        title: change.title,
        archivedAt: change.archivedAt,
        proposal: change.proposal,
        tasks: change.tasks,
        specsTouched: change.specsTouched,
        specDeltas: change.specDeltas
      })),
      specs: input.specs
    })
  );
  return hash.digest("hex").slice(0, 24);
}

async function promoteBackfillDraft(root: string): Promise<BackfillSummary> {
  const promoted = await runPromote({ root });
  const state = promoted.state;
  const phases = collectPhases(state);

  return {
    promoted: true,
    statePath: join(root, TOOL.dataDir, "state.json"),
    reportPath: join(root, TOOL.dataDir, "backfill-report.md"),
    changesRead: phases.reduce((sum, phase) => sum + phase.tasks.flatMap((task) => task.changes).length, 0),
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    lowConfidence: [],
    superseded: [],
    unlinkedChanges: state.unlinkedChanges,
    preservedFormalState: false,
    batches: 0
  };
}

function renderBackfillFailureReport(raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "# Backfill Report (FAILED)",
    "",
    "The backfill agent output could not be parsed into the expected shape.",
    "SpecMarten did NOT write any state, to avoid corrupting existing data. Re-run backfill;",
    "if it keeps failing, the raw agent output below shows what the model returned.",
    "",
    "## Error",
    "",
    "```",
    message,
    "```",
    "",
    "## Raw agent output",
    "",
    "```",
    raw.slice(0, 20000),
    "```",
    ""
  ].join("\n");
}
