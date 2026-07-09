export type AgentName = "claude" | "codex" | "gemini";

export interface AgentRunOptions {
  cwd?: string;
}

export interface AgentRunner {
  name: AgentName;
  isAvailable(): Promise<boolean>;
  run(prompt: string, opts?: AgentRunOptions): Promise<string>;
}
