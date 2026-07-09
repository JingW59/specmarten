import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackfillCommand } from "../src/commands/backfill.js";
import { registerCheckCommand } from "../src/commands/check.js";
import { registerContextCommand } from "../src/commands/context.js";
import type { HeadlessAgent } from "../src/commands/execution-mode.js";
import { registerMaintainCommand } from "../src/commands/maintain.js";
import { registerPlanCommand } from "../src/commands/plan.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { defaultConfig } from "../src/config/config.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { writeJson } from "../src/util/fs.js";

const originalCwd = process.cwd();
const originalHeadless = process.env.SPECMARTEN_HEADLESS;

afterEach(() => {
  process.chdir(originalCwd);
  process.env.SPECMARTEN_HEADLESS = originalHeadless;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("execution mode", () => {
  it("defaults plan/backfill/maintain/check to client-first without calling a headless agent", async () => {
    const root = await createExecutionModeProject();
    const factory = vi.fn(async () => {
      throw new Error("agent factory should not be called");
    });

    await runCommand(root, (program) => registerPlanCommand(program, { createAgent: factory }), [
      "plan",
      "Build status"
    ]);
    await runCommand(root, (program) => registerBackfillCommand(program, { createAgent: factory }), ["backfill"]);
    await archiveChange(root, "add-status-command");
    const maintain = await runCommand(root, (program) => registerMaintainCommand(program, { createAgent: factory }), [
      "maintain",
      "--json"
    ]);
    await runCommand(root, (program) => registerCheckCommand(program, { createAgent: factory }), [
      "check",
      "add-status-command"
    ]);

    expect(JSON.parse(maintain.stdout).mode).toBe("client-first-reconcile");
    const state = await readState(root);
    expect(factory).not.toHaveBeenCalled();
    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
  });

  it("uses the headless agent path when --headless is passed to every interactive command", async () => {
    const root = await createExecutionModeProject();
    const maintainRoot = await createHeadlessMaintainProject();
    const agent = new FakeAgent();
    const factory = vi.fn(async () => agent);

    await runCommand(root, (program) => registerPlanCommand(program, { createAgent: factory }), [
      "plan",
      "Build status",
      "--headless"
    ]);
    await runCommand(root, (program) => registerBackfillCommand(program, { createAgent: factory }), [
      "backfill",
      "--headless"
    ]);
    await runCommand(root, (program) => registerCheckCommand(program, { createAgent: factory }), [
      "check",
      "add-status-command",
      "--headless"
    ]);
    await runCommand(maintainRoot, (program) => registerMaintainCommand(program, { createAgent: factory }), [
      "maintain",
      "--headless"
    ]);

    expect(factory).toHaveBeenCalledTimes(4);
    expect(agent.prompts).toHaveLength(4);
    expect((await readState(root)).lastPatrol?.change).toBe("add-status-command");
  });

  it("uses the headless agent path for every interactive command when SPECMARTEN_HEADLESS=1 is set", async () => {
    const root = await createExecutionModeProject();
    const maintainRoot = await createHeadlessMaintainProject();
    process.env.SPECMARTEN_HEADLESS = "1";
    const agent = new FakeAgent();
    const factory = vi.fn(async () => agent);

    await runCommand(root, (program) => registerPlanCommand(program, { createAgent: factory }), ["plan", "Build status"]);
    await runCommand(root, (program) => registerBackfillCommand(program, { createAgent: factory }), ["backfill"]);
    await runCommand(root, (program) => registerCheckCommand(program, { createAgent: factory }), [
      "check",
      "add-status-command"
    ]);
    await runCommand(maintainRoot, (program) => registerMaintainCommand(program, { createAgent: factory }), ["maintain"]);

    expect(factory).toHaveBeenCalledTimes(4);
    expect(agent.prompts).toHaveLength(4);
  });

  it("keeps deterministic commands unaffected by the global headless switch", async () => {
    const root = await createExecutionModeProject();

    const normal = await runCommand(root, registerContextCommand, [
      "context",
      "--workflow",
      "plan",
      "--requirement",
      "Build status",
      "--json"
    ]);
    const headless = await runCommand(root, registerContextCommand, [
      "--headless",
      "context",
      "--workflow",
      "plan",
      "--requirement",
      "Build status",
      "--json"
    ]);

    expect(JSON.parse(headless.stdout)).toEqual(JSON.parse(normal.stdout));
  });

  it("keeps status deterministic even when the global headless switch is present", async () => {
    const root = await createExecutionModeProject();
    const backendMarker = await import("../src/adapters/spec-backend/openspec.js").then(async ({ OpenSpecBackend }) =>
      new OpenSpecBackend(root).getCurrentMarker()
    );
    await writeMaintainMarker(root, backendMarker);

    const normal = await runCommand(root, registerStatusCommand, ["status", "--json"]);
    const headless = await runCommand(root, registerStatusCommand, ["--headless", "status", "--json"]);

    expect(JSON.parse(headless.stdout)).toEqual(JSON.parse(normal.stdout));
  });

  it("keeps interactive command modules away from static shell-runner imports", async () => {
    const sources = await Promise.all(
      [
        "src/commands/plan.ts",
        "src/commands/backfill.ts",
        "src/commands/maintain.ts",
        "src/commands/check.ts"
      ].map((file) => readFile(join(process.cwd(), file), "utf8"))
    );

    expect(sources.join("\n")).not.toMatch(/shell-runner|createPreferredAgentRunner/);
  });

  it("keeps detection-only command paths away from static shell-runner imports", async () => {
    const sources = await Promise.all(
      ["src/commands/init.ts", "src/core/validate/validate.ts"].map((file) =>
        readFile(join(process.cwd(), file), "utf8")
      )
    );

    expect(sources.join("\n")).not.toMatch(/shell-runner|createPreferredAgentRunner/);
  });
});

async function runCommand(
  root: string,
  register: (program: Command) => void,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
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
  let stdout = "";
  let stderr = "";
  process.chdir(root);

  try {
    await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }

  return { stdout, stderr };
}

class FakeAgent implements HeadlessAgent {
  name = "codex" as const;
  prompts: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (prompt.includes("SpecMarten backfill maintainer")) {
      return JSON.stringify({
        mission: "Status CLI",
        phases: [{ title: "MVP", tasks: [{ title: "Status", changes: ["add-status-command"] }] }],
        unlinkedChanges: [],
        lowConfidence: [],
        superseded: [],
        notes: []
      });
    }

    if (prompt.includes("drift") || prompt.includes("maintenance AI")) {
      return JSON.stringify({
        state: {
          mission: "Status CLI",
          phases: [{ title: "MVP", tasks: [{ title: "Status", status: "done", changes: ["add-status-command"] }] }],
          unlinkedChanges: []
        },
        patrol: {
          change: "add-status-command",
          report: "# Patrol\n\nVERDICT: PASS\n"
        },
        notes: []
      });
    }

    return JSON.stringify({
      mission: "Status CLI",
      phases: [{ id: "p1", title: "MVP", tasks: [{ id: "p1.1", title: "Status", changes: [] }] }],
      questions: [],
      notes: []
    });
  }
}

async function createExecutionModeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-execution-mode-test-"));
  await writeJson(join(root, ".specmarten.json"), defaultConfig());
  await mkdir(join(root, "specmarten", "standards"), { recursive: true });
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "add-status-command", "specs", "status"), { recursive: true });
  await writeFile(join(root, "specmarten", "mission.md"), "# Mission\n\nBuild a status CLI.\n", "utf8");
  await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n", "utf8");
  await writeFile(join(root, "openspec", "changes", "add-status-command", "proposal.md"), "# Add status command\n", "utf8");
  await writeFile(
    join(root, "openspec", "changes", "add-status-command", "specs", "status", "spec.md"),
    "## ADDED Requirements\n### Requirement: Status command\n",
    "utf8"
  );
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI",
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [{ id: "p1.1", title: "Status", status: "in-progress", changes: ["add-status-command"] }]
      }
    ]));
  return root;
}

async function createHeadlessMaintainProject(): Promise<string> {
  const root = await createExecutionModeProject();
  await archiveChange(root, "add-status-command");
  await writeState(root, {
    ...createInitialState(),
    mission: "Status CLI"
  });
  return root;
}

async function archiveChange(root: string, id: string): Promise<void> {
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await rename(join(root, "openspec", "changes", id), join(root, "openspec", "changes", "archive", id));
}
