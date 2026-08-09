import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { SpecBackend } from "../../adapters/spec-backend/types.js";
import { TOOL } from "../../constants.js";
import { pathExists } from "../../util/fs.js";
import { UserFacingError } from "../../util/errors.js";

export interface ArchiveOptions {
  root: string;
  backend: SpecBackend;
  changeId: string;
  /** Archive prefix date in YYYY-MM-DD. Defaults to today (UTC). */
  date?: string;
}

export interface ArchiveSummary {
  changeId: string;
  archivedTo: string;
  archivedAt: string;
}

/**
 * Moves a native change from the active ledger into the date-prefixed archive.
 *
 * This is the deterministic half of the native archive lifecycle. The semantic
 * half (updating accepted specs under ledger/specs/) remains the caller's
 * responsibility, as documented in the native backend lifecycle. After archiving,
 * the caller should run `specmarten closeout` to reconcile state, refresh the
 * baseline, and validate.
 *
 * OpenSpec projects use the native `openspec archive` CLI and are not supported
 * here; this command rejects non-native backends.
 */
export async function runArchive(options: ArchiveOptions): Promise<ArchiveSummary> {
  if (options.backend.kind !== "native") {
    throw new UserFacingError(
      `${TOOL.displayName} archive supports only the native backend. OpenSpec projects use \`openspec archive\`.`
    );
  }

  const archivedAt = normalizeArchiveDate(options.date);
  const activePath = join(options.root, TOOL.dataDir, "ledger", "changes", options.changeId);

  if (!(await pathExists(activePath))) {
    throw new UserFacingError(
      `Active change ${options.changeId} was not found at ${activePath}. Check the change id, or it may already be archived.`
    );
  }

  const archiveDir = join(options.root, TOOL.dataDir, "ledger", "changes", "archive");
  const targetName = `${archivedAt}-${options.changeId}`;
  const targetPath = join(archiveDir, targetName);

  if (await pathExists(targetPath)) {
    throw new UserFacingError(
      `An archived change already exists at ${targetPath}. Remove it or choose a different --date.`
    );
  }

  await rename(activePath, targetPath);

  return {
    changeId: options.changeId,
    archivedTo: targetName,
    archivedAt
  };
}

/** Returns today's UTC date as YYYY-MM-DD, or validates a caller-supplied date. */
function normalizeArchiveDate(date: string | undefined): string {
  if (!date) {
    return new Date().toISOString().slice(0, 10);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UserFacingError(`--date must be in YYYY-MM-DD format, for example 2026-07-12.`);
  }

  return date;
}
