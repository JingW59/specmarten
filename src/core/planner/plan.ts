import { join } from "node:path";
import type { AgentRunner } from "../../adapters/agent/types.js";
import { readContentLanguage } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { UserFacingError } from "../../util/errors.js";
import { extractJsonObject } from "../../util/json.js";
import { runPromote } from "../promote/promote.js";
import { collectPhases, type SpecMartenState } from "../state/schema.js";
import { readExistingOrInitial, readGlobalDocs } from "./input.js";
import { buildPlanPrompt } from "./prompt.js";
import { planAgentResponseSchema } from "./schema.js";
import { writePlanDraft } from "./draft.js";

export interface PlanOptions {
  root: string;
  requirement?: string;
  agent?: AgentRunner;
  promote?: boolean;
}

export interface PlanSummary {
  promoted: boolean;
  statePath: string;
  reportPath?: string;
  phases: number;
  tasks: number;
  questions: string[];
}

export async function runPlan(options: PlanOptions): Promise<PlanSummary> {
  if (options.promote) {
    const promoted = await runPromote({ root: options.root });
    return summarize(options.root, promoted.state, { promoted: true, questions: [] });
  }

  if (!options.requirement?.trim()) {
    throw new UserFacingError("Plan requires a requirement description, for example: specmarten plan \"build login\".");
  }

  if (!options.agent) {
    throw new UserFacingError("Plan requires an available bring-your-own-agent CLI: claude, codex, or gemini.");
  }

  const currentState = await readExistingOrInitial(options.root);
  const docs = await readGlobalDocs(options.root);
  const contentLanguage = await readContentLanguage(options.root);
  const prompt = buildPlanPrompt({
    requirement: options.requirement,
    state: currentState,
    contentLanguage,
    ...docs
  });
  const response = planAgentResponseSchema.parse(extractJsonObject(await options.agent.run(prompt, { cwd: options.root })));
  const draftSummary = await writePlanDraft({
    root: options.root,
    response,
    requirement: options.requirement
  });

  return { promoted: false, ...draftSummary };
}

function summarize(
  root: string,
  state: SpecMartenState,
  opts: { promoted: boolean; questions: string[]; reportPath?: string }
): PlanSummary {
  const phases = collectPhases(state);
  return {
    promoted: opts.promoted,
    statePath: join(root, TOOL.dataDir, "state.json"),
    reportPath: opts.reportPath,
    phases: phases.length,
    tasks: phases.reduce((sum, phase) => sum + phase.tasks.length, 0),
    questions: opts.questions
  };
}
