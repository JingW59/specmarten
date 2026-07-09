import { resolve } from "node:path";
import type { ChangeMeta, SpecMeta } from "../../adapters/spec-backend/types.js";
import { OpenSpecBackend } from "../../adapters/spec-backend/openspec.js";
import { readContentLanguage } from "../../config/config.js";
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
  contentLanguage: ContentLanguage;
  state: SpecMartenState;
  globalDocs: {
    mission: string;
    techStack: string;
    standards: Array<{ path: string; content: string }>;
  };
  openSpec: {
    activeChanges: ChangeMeta[];
    archivedChanges: ChangeMeta[];
    specs: SpecMeta[];
    changes: SerializedBackfillChange[];
  };
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
  const backend = new OpenSpecBackend(root);
  const [state, docs, snapshot, contentLanguage] = await Promise.all([
    readExistingOrInitial(root),
    readGlobalDocs(root),
    readBackfillSnapshot(backend),
    readContentLanguage(root)
  ]);

  return {
    specmartenContext: SPECMARTEN_CONTEXT_VERSION,
    tool: TOOL.cliName,
    version: TOOL.version,
    workflow: "backfill",
    root,
    groupBy,
    contentLanguage,
    state,
    globalDocs: {
      mission: docs.missionDoc,
      techStack: docs.techStackDoc,
      standards: docs.standardsDocs
    },
    openSpec: {
      activeChanges: snapshot.activeChanges,
      archivedChanges: snapshot.archivedChanges,
      specs: snapshot.specs,
      changes: snapshot.changes.map(serializeBackfillChange)
    },
    instruction: backfillInstruction({ groupBy, contentLanguage }),
    outputSchema: backfillOutputSchema(),
    next: {
      writeDraft: `${TOOL.cliName} state write-draft --kind backfill`,
      render: `${TOOL.cliName} render`,
      promote: `${TOOL.cliName} promote`
    }
  };
}
