import { resolve } from "node:path";
import type { ChangeMeta, SpecMeta } from "../../adapters/spec-backend/types.js";
import { OpenSpecBackend } from "../../adapters/spec-backend/openspec.js";
import { readConfig, readContentLanguage } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { readBackfillSnapshot } from "../backfill/snapshot.js";
import { serializeBackfillChange, type SerializedBackfillChange } from "../backfill/prompt.js";
import type { ContentLanguage } from "../content-language.js";
import {
  hasNewUnlinkedChanges,
  reconcileKnownLinks,
  suggestLinksForUnlinkedChanges,
  type SuggestedChangeLink
} from "../maintenance/reconcile.js";
import { maintainInstruction } from "../maintenance/prompt.js";
import { maintainOutputSchema } from "../maintenance/schema.js";
import { runTriage, type TriageResult } from "../overseer/triage.js";
import { readExistingOrInitial, readGlobalDocs } from "../planner/input.js";
import type { SpecMartenState } from "../state/schema.js";
import { SPECMARTEN_CONTEXT_VERSION } from "./plan-context.js";

export interface MaintainContextOptions {
  root: string;
}

export interface MaintainContextEnvelope {
  specmartenContext: typeof SPECMARTEN_CONTEXT_VERSION;
  tool: typeof TOOL.cliName;
  version: typeof TOOL.version;
  workflow: "maintain";
  root: string;
  contentLanguage: ContentLanguage;
  state: SpecMartenState;
  globalDocs: {
    mission: string;
    techStack: string;
    standards: Array<{ path: string; content: string }>;
  };
  reconcile: {
    state: SpecMartenState;
    unlinkedActiveChanges: string[];
    unlinkedChanges: string[];
    hasNewUnlinkedChanges: boolean;
    suggestedLinks: SuggestedChangeLink[];
  };
  triage: TriageResult;
  openSpec: {
    activeChanges: ChangeMeta[];
    archivedChanges: ChangeMeta[];
    specs: SpecMeta[];
    changes: SerializedBackfillChange[];
  };
  instruction: string;
  outputSchema: Record<string, unknown>;
  next: {
    patrolReport: string;
    writeDraft: string;
    render: string;
  };
}

export async function buildMaintainContext(options: MaintainContextOptions): Promise<MaintainContextEnvelope> {
  const root = resolve(options.root);
  const backend = new OpenSpecBackend(root);
  const config = await readConfig(root);
  const [state, docs, snapshot, triage, contentLanguage] = await Promise.all([
    readExistingOrInitial(root),
    readGlobalDocs(root),
    readBackfillSnapshot(backend),
    runTriage(root, config.overseer),
    readContentLanguage(root)
  ]);
  const reconciled = reconcileKnownLinks(state, snapshot.activeChanges, snapshot.archivedChanges);
  const suggestedLinks = suggestLinksForUnlinkedChanges(reconciled, [
    ...snapshot.activeChanges,
    ...snapshot.archivedChanges
  ]);

  return {
    specmartenContext: SPECMARTEN_CONTEXT_VERSION,
    tool: TOOL.cliName,
    version: TOOL.version,
    workflow: "maintain",
    root,
    contentLanguage,
    state,
    globalDocs: {
      mission: docs.missionDoc,
      techStack: docs.techStackDoc,
      standards: docs.standardsDocs
    },
    reconcile: {
      state: reconciled,
      unlinkedActiveChanges: reconciled.unlinkedActiveChanges,
      unlinkedChanges: reconciled.unlinkedChanges,
      hasNewUnlinkedChanges: hasNewUnlinkedChanges(state, reconciled),
      suggestedLinks
    },
    triage,
    openSpec: {
      activeChanges: snapshot.activeChanges,
      archivedChanges: snapshot.archivedChanges,
      specs: snapshot.specs,
      changes: snapshot.changes.map(serializeBackfillChange)
    },
    instruction: maintainInstruction(contentLanguage),
    outputSchema: maintainOutputSchema(),
    next: {
      patrolReport: `${TOOL.cliName} patrol report`,
      writeDraft: `${TOOL.cliName} state write-draft --kind maintain`,
      render: `${TOOL.cliName} render`
    }
  };
}
