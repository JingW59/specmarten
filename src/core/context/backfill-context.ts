import { resolve } from "node:path";
import type { ChangeMeta, SpecMeta } from "../../adapters/spec-backend/types.js";
import { createSpecBackend, resolveSpecBackendName } from "../../adapters/spec-backend/factory.js";
import { readContentLanguage, type SpecBackendName } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { backfillInstruction, serializeBackfillChange, type SerializedBackfillChange } from "../backfill/prompt.js";
import { backfillOutputSchema } from "../backfill/schema.js";
import type { ContentLanguage } from "../content-language.js";
import { readBackfillSnapshot } from "../backfill/snapshot.js";
import { readExistingOrInitial, readGlobalDocs } from "../planner/input.js";
import type { SpecMartenState } from "../state/schema.js";
import { SPECMARTEN_CONTEXT_VERSION } from "./plan-context.js";

export interface BackfillContextOptions {
  root: string;
  groupBy?: "capability" | "time" | "flat" | null;
}

export interface BackfillContextEnvelope {
  specmartenContext: typeof SPECMARTEN_CONTEXT_VERSION;
  tool: typeof TOOL.cliName;
  version: typeof TOOL.version;
  workflow: "backfill";
  root: string;
  groupBy: "capability" | "time" | "flat";
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
    activeChanges: ChangeMeta[];
    archivedChanges: ChangeMeta[];
    specs: SpecMeta[];
    changes: SerializedBackfillChange[];
  };
  ledger: BackfillContextEnvelope["openSpec"];
  instruction: string;
  outputSchema: Record<string, unknown>;
  next: {
    writeDraft: string;
    render: string;
    promote: string;
  };
}

export async function buildBackfillContext(options: BackfillContextOptions): Promise<BackfillContextEnvelope> {
  const root = resolve(options.root);
  const groupBy = options.groupBy ?? "capability";
  const specBackend = await resolveSpecBackendName(root);
  const backend = createSpecBackend(root, specBackend);
  const [state, docs, snapshot, contentLanguage] = await Promise.all([
    readExistingOrInitial(root),
    readGlobalDocs(root),
    readBackfillSnapshot(backend),
    readContentLanguage(root)
  ]);

  const ledger = {
    activeChanges: snapshot.activeChanges,
    archivedChanges: snapshot.archivedChanges,
    specs: snapshot.specs,
    changes: snapshot.changes.map(serializeBackfillChange)
  };

  return {
    specmartenContext: SPECMARTEN_CONTEXT_VERSION,
    tool: TOOL.cliName,
    version: TOOL.version,
    workflow: "backfill",
    root,
    groupBy,
    specBackend,
    contentLanguage,
    state,
    globalDocs: {
      mission: docs.missionDoc,
      techStack: docs.techStackDoc,
      standards: docs.standardsDocs
    },
    openSpec: ledger,
    ledger,
    instruction: backfillInstruction({ groupBy, contentLanguage }),
    outputSchema: backfillOutputSchema(),
    next: {
      writeDraft: `${TOOL.cliName} state write-draft --kind backfill`,
      render: `${TOOL.cliName} render`,
      promote: `${TOOL.cliName} promote`
    }
  };
}
