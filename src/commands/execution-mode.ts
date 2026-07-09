export type AgentName = "claude" | "codex" | "gemini";

export interface HeadlessAgent {
  name: AgentName;
  isAvailable(): Promise<boolean>;
  run(prompt: string, opts?: { cwd?: string }): Promise<string>;
}

export type HeadlessAgentFactory = (prefer: AgentName[]) => Promise<HeadlessAgent>;

export const HEADLESS_OPTION_DESCRIPTION =
  "run the explicit headless agent path for automation/CI (also SPECMARTEN_HEADLESS=1)";

export function isHeadlessRequested(flag?: boolean): boolean {
  return Boolean(flag) || isTruthyEnv(process.env.SPECMARTEN_HEADLESS);
}

export async function createHeadlessAgent(prefer: AgentName[]): Promise<HeadlessAgent> {
  const { createPreferredAgentRunner } = await import("../adapters/agent/shell-runner.js");
  return createPreferredAgentRunner(prefer);
}

export async function maybeCreateHeadlessAgent(prefer: AgentName[]): Promise<HeadlessAgent | undefined> {
  try {
    return await createHeadlessAgent(prefer);
  } catch {
    return undefined;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on";
}
