import { commandExists } from "../util/process.js";
import { installAgentsMdGuidance, type AgentsMdInstallResult } from "./agents-md.js";

export interface CodexInstallResult {
  detected: boolean;
  agentsMd?: AgentsMdInstallResult;
  skippedReason?: string;
}

export async function installCodexFiles(root: string): Promise<CodexInstallResult> {
  if (!(await commandExists("codex"))) {
    return {
      detected: false,
      skippedReason: "No codex CLI detected."
    };
  }

  return { detected: true, agentsMd: await installAgentsMdGuidance(root) };
}
