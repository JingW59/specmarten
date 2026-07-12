import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCheckCommand } from "../src/commands/check.js";
import type { HeadlessAgent } from "../src/commands/execution-mode.js";
import { registerReconcileCommand } from "../src/commands/reconcile.js";
import { registerValidateCommand } from "../src/commands/validate.js";
import { TOOL } from "../src/constants.js";
import { defaultConfig } from "../src/config/config.js";
import type { PatrolVerdict } from "../src/core/overseer/patrol.js";
import { renderViews } from "../src/core/renderers/index.js";
import { createInitialState, writeState } from "../src/core/state/store.js";
import { singleStreamState, type SpecMartenState } from "../src/core/state/schema.js";
import { writeJson, writeText } from "../src/util/fs.js";

vi.mock("../src/adapters/agent/detect.js", () => ({
  detectAvailableAgents: vi.fn(async () => [])
}));

vi.mock("../src/adapters/agent/shell-runner.js", () => ({
  createPreferredAgentRunner: vi.fn(async () => {
    throw new Error("No bring-your-own-agent CLI found. Install claude, codex, or gemini.");
  })
}));

const originalCwd = process.cwd();
const originalHeadless = process.env.SPECMARTEN_HEADLESS;

afterEach(() => {
  process.chdir(originalCwd);
  process.env.SPECMARTEN_HEADLESS = originalHeadless;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("CI gate exit-code contract", () => {
  it("maps check PASS/WARN/BLOCK verdicts to documented exit codes", async () => {
    const cases: Array<{ verdict: PatrolVerdict; exitCode: number }> = [
      { verdict: "PASS", exitCode: 0 },
      { verdict: "WARN", exitCode: 10 },
      { verdict: "BLOCK", exitCode: 2 }
    ];

    for (const { verdict, exitCode } of cases) {
      const root = await createCiGateProject();
      const agent = new VerdictAgent(verdict);
      const factory = vi.fn(async () => agent);

      await runCommand(root, (program) => registerCheckCommand(program, { createAgent: factory }), [
        "check",
        "ci-drift-gate",
        "--headless"
      ]);

      expect(process.exitCode).toBe(exitCode);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(agent.prompts).toHaveLength(1);
    }
  });

  it("sets validate exit code to 1 for invalid projects and 0 for valid projects", async () => {
    const invalidRoot = await createCiGateProject();
    await runCommand(invalidRoot, registerValidateCommand, ["validate"]);
    expect(process.exitCode).toBe(1);

    const validRoot = await createCiGateProject({ renderGeneratedViews: true });
    await runCommand(validRoot, registerValidateCommand, ["validate"]);
    expect(process.exitCode).toBe(0);
  });

  it("sets validate --complete exit code to 1 when active checklist progress is unfinished", async () => {
    const root = await createCiGateProject({ renderGeneratedViews: true });

    await runCommand(root, registerValidateCommand, ["validate", "--complete"]);

    expect(process.exitCode).toBe(1);
  });

  it("lets deterministic hard-contract checks block even when no headless agent is installed", async () => {
    const root = await createCiGateProject();
    const result = await runCommand(root, registerCheckCommand, [
      "check",
      "ci-drift-gate",
      "--headless",
      "--json",
      "--diff",
      `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
-export function removedPublicApi() {}
`
    ]);
    const summary = JSON.parse(result.stdout) as { verdict: string; exitCode: number; report: string };
    const report = await readFile(join(root, "specmarten", summary.report), "utf8");

    expect(process.exitCode).toBe(2);
    expect(summary).toMatchObject({ verdict: "BLOCK", exitCode: 2 });
    expect(report).toContain("agent: deterministic-hard-contract");
    expect(report).toContain("removedPublicApi");
  });

  it("keeps reconcile deterministic, non-failing, and away from agent imports", async () => {
    const root = await createCiGateProject();

    await runCommand(root, registerReconcileCommand, ["reconcile"]);

    expect(process.exitCode ?? 0).toBe(0);

    const sources = await Promise.all(
      ["src/commands/reconcile.ts", "src/core/reconcile/reconcile.ts", "src/core/maintenance/reconcile.ts"].map(
        (file) => readFile(join(originalCwd, file), "utf8")
      )
    );
    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });

  it("keeps copyable CI examples aligned with the package and CLI names", async () => {
    const packageJson = JSON.parse(await readFile(join(originalCwd, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };
    const binName = Object.keys(packageJson.bin)[0];
    const exampleFiles = [
      "examples/ci/README.md",
      "examples/ci/drift-gate.sh",
      "examples/ci/github-actions-drift-gate.yml"
    ];
    const joined = (
      await Promise.all(exampleFiles.map((file) => readFile(join(originalCwd, file), "utf8")))
    ).join("\n");

    expect(binName).toBe(packageJson.name);
    expect(joined).toContain(`npm i -g ${packageJson.name}`);
    expect(joined).toContain(`${binName} validate`);
    expect(joined).toContain(`${binName} reconcile`);
    expect(joined).toContain(`${binName} check`);
    expect(joined).toContain("SPECMARTEN_GATE_CHANGE");
    const legacyCliName = "over" + "spec";
    const legacyEnvPrefix = "OVER" + "SPEC_";
    expect(joined).not.toMatch(new RegExp(`\\b${legacyCliName}\\b`, "i"));
    expect(joined).not.toContain(legacyEnvPrefix);
  });

  it("keeps the CLI version aligned with package.json", async () => {
    const packageJson = JSON.parse(await readFile(join(originalCwd, "package.json"), "utf8")) as {
      version: string;
    };

    expect(TOOL.version).toBe(packageJson.version);
  });

  it("builds before packaging and checks the packed CLI output in CI", async () => {
    const packageJson = JSON.parse(await readFile(join(originalCwd, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const ci = await readFile(join(originalCwd, ".github", "workflows", "ci.yml"), "utf8");

    expect(packageJson.scripts.prepack).toBe("npm run build");
    expect(ci).toContain("npm pack --dry-run --json");
    expect(ci).toContain("dist/index.js");
  });
});

async function runCommand(
  root: string,
  register: (program: Command) => void,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  program.option("--headless", "run headless");
  register(program);
  const log = vi.spyOn(console, "log").mockImplementation((...chunks: unknown[]) => {
    stdout += `${chunks.join(" ")}\n`;
  });
  const error = vi.spyOn(console, "error").mockImplementation((...chunks: unknown[]) => {
    stderr += `${chunks.join(" ")}\n`;
  });
  process.chdir(root);

  try {
    await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }

  return { stdout, stderr };
}

class VerdictAgent implements HeadlessAgent {
  name = "codex" as const;
  prompts: string[] = [];

  constructor(private readonly verdict: PatrolVerdict) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return JSON.stringify({
      state: {
        mission: "CI drift gate",
        phases: [
          {
            title: "CI",
            tasks: [{ title: "Gate drift", status: "in-progress", changes: ["ci-drift-gate"] }]
          }
        ],
        unlinkedChanges: []
      },
      patrol: {
        change: "ci-drift-gate",
        report: `# Patrol\n\nVERDICT: ${this.verdict}\n`
      },
      notes: []
    });
  }
}

async function createCiGateProject(opts: { renderGeneratedViews?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-ci-gate-contract-test-"));
  const state: SpecMartenState = singleStreamState({
    ...createInitialState(),
    mission: "CI drift gate"
  }, [
      {
        id: "p1",
        title: "CI",
        status: "in-progress",
        tasks: [{ id: "p1.1", title: "Gate drift", status: "in-progress", changes: ["ci-drift-gate"] }]
      }
    ]);

  await writeJson(join(root, ".specmarten.json"), defaultConfig("openspec"));
  await mkdir(join(root, "openspec", "specs", "ci-drift-gate"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "ci-drift-gate", "specs", "ci-drift-gate"), { recursive: true });
  await writeText(join(root, "openspec", "specs", "ci-drift-gate", "spec.md"), "# CI Drift Gate Spec\n");
  await writeText(join(root, "openspec", "changes", "ci-drift-gate", "proposal.md"), "# CI drift gate\n");
  await writeText(
    join(root, "openspec", "changes", "ci-drift-gate", "specs", "ci-drift-gate", "spec.md"),
    "## ADDED Requirements\n### Requirement: Gate honors the documented exit-code contract\n"
  );
  await writeState(root, state);
  if (opts.renderGeneratedViews) {
    await renderViews(root, state);
  }

  return root;
}
