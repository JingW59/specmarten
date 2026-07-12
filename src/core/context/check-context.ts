import { join, relative, resolve } from "node:path";
import type { ChangeDetail } from "../../adapters/spec-backend/types.js";
import { createSpecBackend } from "../../adapters/spec-backend/factory.js";
import { readConfig, readContentLanguage, type SpecBackendName } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { UserFacingError } from "../../util/errors.js";
import { listFilePathsRecursive, readText } from "../../util/fs.js";
import { checkInstruction, patrolReportOutputSchema } from "../overseer/prompt.js";
import { runTriage, type TriageResult } from "../overseer/triage.js";
import type { ContentLanguage } from "../content-language.js";
import { readExistingOrInitial, readGlobalDocs } from "../planner/input.js";
import type { SpecMartenState } from "../state/schema.js";
import { SPECMARTEN_CONTEXT_VERSION } from "./plan-context.js";

export interface CheckContextOptions {
  root: string;
  change: string;
}

export interface SerializedCheckChange {
  id: string;
  status: ChangeDetail["status"];
  title?: string;
  archivedAt?: string;
  specsTouched: string[];
  proposal?: string;
  tasks?: string;
  specDeltas: Array<{ path: string; contentPreview: string }>;
}

export interface CheckContextEnvelope {
  specmartenContext: typeof SPECMARTEN_CONTEXT_VERSION;
  tool: typeof TOOL.cliName;
  version: typeof TOOL.version;
  workflow: "check";
  root: string;
  change: string;
  specBackend: SpecBackendName;
  contentLanguage: ContentLanguage;
  state: SpecMartenState;
  globalDocs: {
    mission: string;
    techStack: string;
    standards: Array<{ path: string; content: string }>;
  };
  /** @deprecated Use `ledger`. Retained through 0.x for compatibility. */
  openSpec: {
    change: SerializedCheckChange;
    baselineSpecs: Array<{ path: string; content: string }>;
  };
  ledger: CheckContextEnvelope["openSpec"];
  triage: TriageResult;
  instruction: string;
  outputSchema: Record<string, unknown>;
  next: {
    patrolReport: string;
  };
}

export async function buildCheckContext(options: CheckContextOptions): Promise<CheckContextEnvelope> {
  const root = resolve(options.root);
  const config = await readConfig(root);
  const backend = createSpecBackend(root, config.specBackend);
  const [state, docs, activeChanges, archivedChanges, triage, baselineSpecs, contentLanguage] = await Promise.all([
    readExistingOrInitial(root),
    readGlobalDocs(root),
    backend.listActiveChanges(),
    backend.listArchivedChanges(),
    runTriage(root, config.overseer),
    readBaselineSpecs(root),
    readContentLanguage(root)
  ]);
  const changeMeta = [...activeChanges, ...archivedChanges].find((change) => change.id === options.change);
  if (!changeMeta) {
    throw new UserFacingError(`Change not found in the configured backend: ${options.change}`);
  }
  const change = await backend.readChange(changeMeta.id);

  const ledger = {
    change: serializeCheckChange(change),
    baselineSpecs
  };

  return {
    specmartenContext: SPECMARTEN_CONTEXT_VERSION,
    tool: TOOL.cliName,
    version: TOOL.version,
    workflow: "check",
    root,
    change: changeMeta.id,
    specBackend: config.specBackend,
    contentLanguage,
    state,
    globalDocs: {
      mission: docs.missionDoc,
      techStack: docs.techStackDoc,
      standards: docs.standardsDocs
    },
    openSpec: ledger,
    ledger,
    triage,
    instruction: checkInstruction(contentLanguage),
    outputSchema: patrolReportOutputSchema(),
    next: {
      patrolReport: `${TOOL.cliName} patrol report`
    }
  };
}

function serializeCheckChange(change: ChangeDetail): SerializedCheckChange {
  return {
    id: change.id,
    status: change.status,
    title: change.title,
    archivedAt: change.archivedAt,
    specsTouched: change.specsTouched,
    proposal: change.proposal,
    tasks: change.tasks,
    specDeltas: change.specDeltas.map((delta) => ({
      path: delta.path,
      contentPreview: delta.content.slice(0, 4000)
    }))
  };
}

async function readBaselineSpecs(root: string): Promise<Array<{ path: string; content: string }>> {
  const baselineRoot = join(root, TOOL.dataDir, "baseline", "specs-snapshot");
  const files = await listFilePathsRecursive(baselineRoot);
  return Promise.all(
    files.map(async (file) => ({
      path: relative(baselineRoot, file),
      content: await readText(file)
    }))
  );
}
