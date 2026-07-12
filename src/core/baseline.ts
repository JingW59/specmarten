import { join } from "node:path";
import { TOOL } from "../constants.js";
import type { SpecBackend } from "../adapters/spec-backend/types.js";
import { UserFacingError } from "../util/errors.js";
import { pathExists, writeJson } from "../util/fs.js";
import { findPurposeTbdIssues, formatPurposeTbdIssue } from "./openspec/purpose.js";
import { renderViews } from "./renderers/index.js";
import type { SpecMartenBaseline } from "./state/schema.js";
import { readState, statePath, writeState } from "./state/store.js";

export interface BaselineRefreshSummary {
  baselinePath: string;
  snapshotPath: string;
  statePath: string;
  specsHash: string;
  copiedFiles: number;
  at: string;
  rendered: boolean;
}

export async function createBaselineIfMissing(root: string, backend: SpecBackend): Promise<SpecMartenBaseline> {
  const baselineRoot = join(root, TOOL.dataDir, "baseline");
  const baselineJson = join(baselineRoot, "baseline.json");

  if (await pathExists(baselineJson)) {
    const { readJson } = await import("../util/fs.js");
    const existing = await readJson<{ specsHash: string; at: string }>(baselineJson);
    return { specsHash: existing.specsHash, at: existing.at };
  }

  const snapshot = await backend.snapshotSpecs(join(baselineRoot, "specs-snapshot"));
  const baseline = {
    specsHash: snapshot.specsHash,
    at: new Date().toISOString()
  };
  await writeJson(baselineJson, {
    ...baseline,
    copiedFiles: snapshot.copiedFiles
  });
  return baseline;
}

export async function refreshBaseline(options: {
  root: string;
  backend: SpecBackend;
  noRender?: boolean;
}): Promise<BaselineRefreshSummary> {
  if (!(await options.backend.isPresent())) {
    throw new UserFacingError("The configured specification backend is not present.");
  }

  const purposeIssues = options.backend.kind === "native" ? [] : await findPurposeTbdIssues(options.backend);
  if (purposeIssues.length > 0) {
    throw new UserFacingError(formatPurposeTbdIssue(purposeIssues[0]!));
  }

  const baselineRoot = join(options.root, TOOL.dataDir, "baseline");
  const baselineJson = join(baselineRoot, "baseline.json");
  const snapshotPath = join(baselineRoot, "specs-snapshot");
  const snapshot = await options.backend.snapshotSpecs(snapshotPath);
  const at = new Date().toISOString();
  const baseline = {
    specsHash: snapshot.specsHash,
    at
  };

  await writeJson(baselineJson, {
    ...baseline,
    copiedFiles: snapshot.copiedFiles
  });

  const state = await readState(options.root);
  const nextState = {
    ...state,
    updatedAt: at,
    baseline
  };
  await writeState(options.root, nextState);
  if (!options.noRender) {
    await renderViews(options.root, nextState);
  }

  return {
    baselinePath: baselineJson,
    snapshotPath,
    statePath: statePath(options.root),
    specsHash: snapshot.specsHash,
    copiedFiles: snapshot.copiedFiles,
    at,
    rendered: !options.noRender
  };
}
