import { commandExists } from "../../util/process.js";
import type { AgentName } from "./types.js";

const COMMAND_BY_AGENT: Record<AgentName, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini"
};

export async function detectAvailableAgents(prefer: AgentName[]): Promise<AgentName[]> {
  const available: AgentName[] = [];

  for (const name of prefer) {
    if (await commandExists(COMMAND_BY_AGENT[name])) {
      available.push(name);
    }
  }

  return available;
}
