import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, runProcess } from "../../util/process.js";
import { UserFacingError } from "../../util/errors.js";
import { detectAvailableAgents } from "./detect.js";
import type { AgentName, AgentRunOptions, AgentRunner } from "./types.js";

const COMMAND_BY_AGENT: Record<AgentName, { command: string; args: string[] }> = {
  claude: { command: "claude", args: ["-p"] },
  codex: { command: "codex", args: ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never"] },
  gemini: { command: "gemini", args: ["-p", ""] }
};

export class ShellAgentRunner implements AgentRunner {
  readonly name: AgentName;
  private readonly command: string;
  private readonly args: string[];

  constructor(name: AgentName) {
    this.name = name;
    this.command = COMMAND_BY_AGENT[name].command;
    this.args = COMMAND_BY_AGENT[name].args;
  }

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  async run(prompt: string, opts: AgentRunOptions = {}): Promise<string> {
    if (!(await this.isAvailable())) {
      throw new UserFacingError(
        `No ${this.name} CLI found. Install ${this.command} or configure another bring-your-own-agent runner.`
      );
    }

    const { args, outputFile, cleanup } = await this.prepareRunArgs();

    try {
      const result = await runProcess(this.command, args, { cwd: opts.cwd, input: prompt });

      if (result.code !== 0) {
        throw new UserFacingError(`${this.name} exited with code ${result.code}: ${result.stderr.trim()}`);
      }

      if (outputFile) {
        const finalMessage = await readFile(outputFile, "utf8").catch(() => "");
        if (finalMessage.trim()) {
          return finalMessage;
        }
      }

      return result.stdout;
    } finally {
      await cleanup();
    }
  }

  private async prepareRunArgs(): Promise<{ args: string[]; outputFile?: string; cleanup: () => Promise<void> }> {
    if (this.name !== "codex") {
      return { args: this.args, cleanup: async () => {} };
    }

    const dir = await mkdtemp(join(tmpdir(), "specmarten-codex-"));
    const outputFile = join(dir, "last-message.txt");

    return {
      args: [...this.args, "--output-last-message", outputFile, "-"],
      outputFile,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      }
    };
  }
}

export { detectAvailableAgents };

export async function createPreferredAgentRunner(prefer: AgentName[]): Promise<AgentRunner> {
  for (const name of prefer) {
    const runner = new ShellAgentRunner(name);
    if (await runner.isAvailable()) {
      return runner;
    }
  }

  throw new UserFacingError("No bring-your-own-agent CLI found. Install claude, codex, or gemini.");
}
