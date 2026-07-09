import { resolve } from "node:path";
import { readContentLanguage } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import type { ContentLanguage } from "../content-language.js";
import type { SpecMartenState } from "../state/schema.js";
import { readExistingOrInitial, readGlobalDocs } from "../planner/input.js";
import { planInstruction } from "../planner/prompt.js";
import { planOutputSchema } from "../planner/schema.js";

export const SPECMARTEN_CONTEXT_VERSION = 1;

export interface PlanContextOptions {
  root: string;
  requirement?: string | null;
}

export interface PlanContextEnvelope {
  specmartenContext: typeof SPECMARTEN_CONTEXT_VERSION;
  tool: typeof TOOL.cliName;
  version: typeof TOOL.version;
  workflow: "plan";
  root: string;
  requirement: string | null;
  contentLanguage: ContentLanguage;
  state: SpecMartenState;
  globalDocs: {
    mission: string;
    techStack: string;
    standards: Array<{ path: string; content: string }>;
  };
  instruction: string;
  outputSchema: Record<string, unknown>;
  next: {
    writeDraft: string;
    render: string;
    promote: string;
  };
}

export async function buildPlanContext(options: PlanContextOptions): Promise<PlanContextEnvelope> {
  const root = resolve(options.root);
  const [state, docs, contentLanguage] = await Promise.all([
    readExistingOrInitial(root),
    readGlobalDocs(root),
    readContentLanguage(root)
  ]);
  const requirement = options.requirement?.trim() || null;

  return {
    specmartenContext: SPECMARTEN_CONTEXT_VERSION,
    tool: TOOL.cliName,
    version: TOOL.version,
    workflow: "plan",
    root,
    requirement,
    contentLanguage,
    state,
    globalDocs: {
      mission: docs.missionDoc,
      techStack: docs.techStackDoc,
      standards: docs.standardsDocs
    },
    instruction: planInstruction(contentLanguage),
    outputSchema: planOutputSchema(),
    next: {
      writeDraft: `${TOOL.cliName} state write-draft --kind plan`,
      render: `${TOOL.cliName} render`,
      promote: `${TOOL.cliName} promote`
    }
  };
}
