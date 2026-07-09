import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig } from "../src/config/config.js";
import { runInit } from "../src/commands/init.js";
import { runBackfill } from "../src/core/backfill/backfill.js";
import { runCheck } from "../src/core/check/check.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { runMaintain } from "../src/core/maintenance/maintain.js";
import { runPlan } from "../src/core/planner/plan.js";
import { collectPhases } from "../src/core/state/schema.js";
import { readState } from "../src/core/state/store.js";
import { runStatus } from "../src/core/status/status.js";

const originalCodexHome = process.env.CODEX_HOME;

beforeEach(async () => {
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "specmarten-e2e-codex-home-"));
});

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

describe("end-to-end smoke", () => {
  it("isolates Codex home for init side effects", async () => {
    const codexHome = process.env.CODEX_HOME ?? "";
    expect(codexHome).toContain("specmarten-e2e-codex-home-");
    expect(codexHome).not.toBe(originalCodexHome);
  });

  it("I1 greenfield: init, plan, promote, native archive, status signals deterministic maintenance need", async () => {
    const root = await tempRoot();
    await cp(join(process.cwd(), "examples", "greenfield-sample", "openspec"), join(root, "openspec"), {
      recursive: true
    });

    await runInit({ root, noClaude: true, noGitHook: true });
    await runPlan({ root, requirement: "Build status command", agent: new PlanAgent() });
    await runPlan({ root, promote: true });
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await addActiveChange(root, "do-status");
    await runMaintain({ root, backend, config: defaultConfig(), agent: new MaintainLinkAgent("do-status") });
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");

    const status = await runStatus({ root, backend, config: defaultConfig() });
    const state = await readState(root);

    expect(status.maintain.earlyExit).toBe(false);
    expect(status.maintain.agentCalled).toBe(false);
    expect(status.maintain.needsAgent).toBe(false);
    expect(status.maintain.needsReconcile).toBe(true);
    expect(status.maintain.recommendedCommand).toBe("specmarten maintain");
    expect(status.maintain.unlinkedActiveChanges).toEqual([]);
    expect(status.maintain.unlinkedChanges).toEqual([]);
    expect(status.doneTasks).toBe(0);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({ status: "in-progress", changes: ["do-status"] });
  });

  it("I2 brownfield: explicit headless init backfills sample, promote, later archive syncs from baseline", async () => {
    const root = await tempRoot();
    await cp(join(process.cwd(), "examples", "brownfield-sample", "openspec"), join(root, "openspec"), {
      recursive: true
    });

    const init = await runInit({ root, noClaude: true, noGitHook: true, headless: true, agentRunner: new BackfillAgent() });
    expect(init.backfill?.tasks).toBe(2);
    await runBackfill({ root, backend: new OpenSpecBackend(root), promote: true });
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "add-status-command");

    const maintain = await runMaintain({ root, backend, config: defaultConfig(), agent: new ThrowingAgent() });
    const state = await readState(root);

    expect(maintain.agentCalled).toBe(false);
    expect(collectPhases(state)[0]?.tasks.find((task) => task.changes.includes("add-status-command"))?.status).toBe("done");
    expect(state.baseline?.specsHash).toMatch(/^sha256:/);
  });

  it("E4 check fixture: contract-breaking change can be reported as BLOCK", async () => {
    const root = await tempRoot();
    await createGreenfieldOpenSpec(root);
    await addActiveChange(root, "break-output-contract");
    await runPlan({ root, requirement: "Keep output contract", agent: new PlanAgent() });
    await runPlan({ root, promote: true });

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig(),
      agent: new BlockCheckAgent(),
      change: "break-output-contract"
    });
    const state = await readState(root);

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.exitCode).toBe(2);
    expect(state.lastPatrol?.verdict).toBe("BLOCK");
    await expect(readFile(join(root, "specmarten", summary.report), "utf8")).resolves.toContain("VERDICT: BLOCK");
  });
});

class PlanAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      mission: "Status CLI",
      phases: [
        {
          id: "p1",
          title: "MVP",
          status: "planned",
          tasks: [{ id: "p1.1", title: "Build status command", status: "todo", changes: [] }]
        }
      ],
      questions: [],
      notes: []
    });
  }
}

class MaintainLinkAgent implements AgentRunner {
  name = "codex" as const;
  constructor(private readonly change: string) {}
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      state: {
        version: 1,
        updatedAt: new Date().toISOString(),
        mission: "Status CLI",
        phases: [
          {
            id: "p1",
            title: "MVP",
            status: "done",
            tasks: [
              {
                id: "p1.1",
                title: "Build status command",
                status: "done",
                changes: [this.change],
                archivedAt: "2026-06-21"
              }
            ]
          }
        ],
        lastPatrol: null,
        baseline: null,
        unlinkedChanges: []
      },
      notes: []
    });
  }
}

class BackfillAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      mission: "Account sample",
      phases: [
        {
          title: "Account MVP",
          tasks: [
            { title: "Add login flow", changes: ["2026-06-01-add-login"] },
            { title: "Add status command", changes: ["add-status-command"] }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class ThrowingAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run(): Promise<string> {
    throw new Error("agent should not be called");
  }
}

class BlockCheckAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      patrol: {
        change: "break-output-contract",
        report: `# Overseer 巡检报告 · break-output-contract
## 概要
The change modifies an already-declared output field without declaring the contract change.
## 发现
| # | 维度 | 严重度 | 位置(文件:符号) | 说明 | 建议 |
| 1 | 接口契约 | BLOCK | openspec/specs/status/spec.md:output | Declared output contract changed without matching change spec. | Add OpenSpec delta or revert. |
## 回写建议
- 无

VERDICT: BLOCK
`
      },
      notes: []
    });
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-e2e-test-"));
}

async function createGreenfieldOpenSpec(root: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n", "utf8");
}

async function addActiveChange(root: string, id: string): Promise<void> {
  await mkdir(join(root, "openspec", "changes", id, "specs", "status"), { recursive: true });
  await writeFile(join(root, "openspec", "changes", id, "proposal.md"), `# ${id}\n`, "utf8");
  await writeFile(join(root, "openspec", "changes", id, "specs", "status", "spec.md"), "## ADDED Requirements\n", "utf8");
}

async function archiveChange(root: string, id: string): Promise<void> {
  await rename(join(root, "openspec", "changes", id), join(root, "openspec", "changes", "archive", id));
}
