import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TOOL } from "../../constants.js";
import { UserFacingError } from "../../util/errors.js";
import { ensureDir, pathExists, readJson, writeJson } from "../../util/fs.js";
import {
  baselineSchema,
  phaseSchema,
  type SpecMartenBaseline,
  type SpecMartenState,
  stateSchema
} from "./schema.js";
import { z } from "zod";

export function statePath(root: string): string {
  return join(root, TOOL.dataDir, "state.json");
}

export function stateLockPath(root: string): string {
  return join(root, TOOL.dataDir, ".state.json.lock");
}

export function createInitialState(opts: { baseline?: SpecMartenBaseline | null } = {}): SpecMartenState {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    mission: "",
    currentVersion: "",
    streams: [],
    lastPatrol: null,
    baseline: opts.baseline ? baselineSchema.parse(opts.baseline) : null,
    unlinkedActiveChanges: [],
    unlinkedChanges: []
  };
}

export async function readState(root: string): Promise<SpecMartenState> {
  const path = statePath(root);
  try {
    return migrateState(await readJson<unknown>(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserFacingError(
        `${TOOL.displayName} state is missing at ${TOOL.dataDir}/state.json. Run \`${TOOL.cliName} init\` first.`
      );
    }
    if (error instanceof SyntaxError) {
      throw new UserFacingError(
        `Failed to parse ${TOOL.dataDir}/state.json: invalid JSON. Restore the file from version control or rerun \`${TOOL.cliName} init\` in a clean project.`
      );
    }
    throw error;
  }
}

export async function writeState(root: string, state: SpecMartenState): Promise<void> {
  await withStateWriteLock(root, async () => {
    await writeJson(statePath(root), stateSchema.parse(state));
  });
}

const legacyStateSchema = z.object({
  version: z.number().optional(),
  draft: z.boolean().optional(),
  draftKind: z.enum(["plan", "backfill"]).optional(),
  updatedAt: z.string(),
  mission: z.string().default(""),
  phases: z.array(phaseSchema).default([]),
  lastPatrol: z
    .object({
      change: z.string(),
      verdict: z.enum(["PASS", "WARN", "BLOCK"]),
      report: z.string(),
      at: z.string()
    })
    .nullable()
    .optional(),
  baseline: baselineSchema.nullable().optional(),
  unlinkedChanges: z.array(z.string()).default([])
});

export function migrateState(input: unknown): SpecMartenState {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (record.version === 1 || !("streams" in record)) {
      const legacy = legacyStateSchema.parse(input);
      return stateSchema.parse({
        version: 2,
        draft: legacy.draft,
        draftKind: legacy.draftKind,
        updatedAt: legacy.updatedAt,
        mission: legacy.mission,
        currentVersion: "v1",
        streams: [
          {
            id: "v1",
            version: "v1",
            label: "v1",
            state: "active",
            phases: legacy.phases
          }
        ],
        lastPatrol: legacy.lastPatrol,
        baseline: legacy.baseline,
        unlinkedActiveChanges: [],
        unlinkedChanges: legacy.unlinkedChanges
      });
    }
  }

  return stateSchema.parse(input);
}

export async function writeInitialStateIfMissing(
  root: string,
  opts: { baseline?: SpecMartenBaseline | null } = {}
): Promise<boolean> {
  return withStateWriteLock(root, async () => {
    const path = statePath(root);
    if (await pathExists(path)) {
      return false;
    }

    await writeJson(path, createInitialState(opts));
    return true;
  });
}

export async function hasState(root: string): Promise<boolean> {
  return pathExists(statePath(root));
}

export async function promoteDraftState(root: string): Promise<SpecMartenState> {
  const state = await readState(root);
  if (!state.draft) {
    throw new UserFacingError("No draft state is present in specmarten/state.json.");
  }

  const promoted = {
    ...state,
    draft: undefined,
    draftKind: undefined,
    updatedAt: new Date().toISOString()
  };
  await writeState(root, promoted);
  return promoted;
}

async function withStateWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await ensureDir(dirname(statePath(root)));
  const lockPath = stateLockPath(root);
  await acquireStateWriteLock(lockPath);

  try {
    return await operation();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

async function acquireStateWriteLock(lockPath: string): Promise<void> {
  const retries = 100;
  const delayMs = 25;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      await sleep(delayMs);
    }
  }

  throw new UserFacingError(
    `Timed out waiting for specmarten/state.json lock. If no SpecMarten command is running, remove ${lockPath} and retry.`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
