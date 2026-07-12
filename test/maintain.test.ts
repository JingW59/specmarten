import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig, type SpecMartenConfig } from "../src/config/config.js";
import { runMaintain } from "../src/core/maintenance/maintain.js";
import { writeMaintainDraft } from "../src/core/maintenance/draft.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { runTriage } from "../src/core/overseer/triage.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { ensureDir, pathExists, writeJson } from "../src/util/fs.js";
import { runProcess } from "../src/util/process.js";

describe("maintain", () => {
  it("marks an already AI-linked archived change done and renders without calling an agent", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-hunk");

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new ThrowingAgent()
    });
    const state = await readState(root);

    expect(summary.changed).toBe(true);
    expect(summary.agentCalled).toBe(false);
    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain("[x] Build hunk support");
    expect(await pathExists(join(root, "specmarten", "dashboard.html"))).toBe(true);
  });

  it("marks a linked active change done when its checklist is complete", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeFile(join(root, "openspec", "changes", "do-hunk", "tasks.md"), "# Tasks\n\n- [x] Build hunk support\n", "utf8");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");

    const summary = await runMaintain({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      agent: new ThrowingAgent()
    });
    const state = await readState(root);

    expect(summary.agentCalled).toBe(false);
    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
  });

  it("reconciles stale checklist progress even when the OpenSpec marker is unchanged", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeFile(join(root, "openspec", "changes", "do-hunk", "tasks.md"), "# Tasks\n\n- [x] Build hunk support\n", "utf8");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new ThrowingAgent()
    });
    const state = await readState(root);

    expect(summary.changed).toBe(true);
    expect(summary.earlyExit).toBe(false);
    expect(summary.agentCalled).toBe(false);
    expect(summary.rendered).toBe(true);
    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain("100%");
  });

  it("keeps deterministic checklist completion after a maintain draft merges agent state", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeFile(join(root, "openspec", "changes", "do-hunk", "tasks.md"), "# Tasks\n\n- [x] Build hunk support\n", "utf8");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");

    await writeMaintainDraft({
      root,
      backend: new OpenSpecBackend(root),
      response: {
        state: {
          phases: [
            {
              id: "p1",
              title: "MVP",
              status: "in-progress",
              tasks: [{ id: "p1.1", title: "Build hunk support", status: "in-progress", changes: ["do-hunk"] }]
            }
          ]
        },
        notes: []
      }
    });
    const state = await readState(root);

    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
  });

  it("uses the maintenance AI to semantically link an unlinked archived change", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeProjectConfig(root);
    await writeState(root, singleStreamState({
      ...createInitialState()
    }, [
        {
          id: "p1",
          title: "MVP",
          status: "in-progress",
          tasks: [{ id: "p1.1", title: "Build hunk support", status: "in-progress", changes: [] }]
        }
      ]));
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "2026-06-21-do-hunk", "do-hunk");

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new SemanticSyncAgent("2026-06-21-do-hunk")
    });
    const state = await readState(root);

    expect(summary.agentCalled).toBe(true);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "done",
      changes: ["2026-06-21-do-hunk"]
    });
  });

  it("uses the maintenance AI to semantically link an unlinked active change", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeProjectConfig(root);
    await writeState(root, singleStreamState({
      ...createInitialState(),
    }, [
        {
          id: "p1",
          title: "MVP",
          status: "in-progress",
          tasks: [{ id: "p1.1", title: "Build hunk support", status: "todo", changes: [] }]
        }
      ]));
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new SemanticSyncAgent("do-hunk")
    });
    const state = await readState(root);

    expect(summary.agentCalled).toBe(true);
    expect(state.unlinkedActiveChanges).toEqual([]);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "in-progress",
      changes: ["do-hunk"]
    });
  });

  it("exits early with no agent call when the OpenSpec marker has not changed", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new ThrowingAgent()
    });

    expect(summary.earlyExit).toBe(true);
    expect(summary.agentCalled).toBe(false);
    expect(summary.rendered).toBe(false);
  });

  it("runs patrol on sensitive changes, writes a report, and records lastPatrol", async () => {
    const root = await tempRoot();
    await gitInit(root);
    await createOpenSpecWithActiveChange(root, "do-hunk");
    await writeProjectConfig(root);
    await writeLinkedState(root, "do-hunk");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-hunk");
    await ensureDir(join(root, "src"));
    await writeFile(join(root, "src", "models.ts"), "export class AddedModel {}\n", "utf8");

    const summary = await runMaintain({
      root,
      backend,
      config: defaultConfig("openspec"),
      agent: new PatrolAgent("WARN")
    });
    const state = await readState(root);

    expect(summary.triage.hit).toBe(true);
    expect(summary.report).toMatch(/^reports\//);
    expect(summary.verdict).toBe("WARN");
    expect(state.lastPatrol?.verdict).toBe("WARN");
    await expect(readFile(join(root, "specmarten", state.lastPatrol!.report), "utf8")).resolves.toContain("VERDICT: WARN");
  });

  it("detects untracked sensitive files during triage", async () => {
    const root = await tempRoot();
    await gitInit(root);
    await ensureDir(join(root, "src"));
    await writeFile(join(root, "src", "models.ts"), "export class AddedModel {}\n", "utf8");

    const triage = await runTriage(root, defaultConfig("openspec").overseer);

    expect(triage.hit).toBe(true);
    expect(triage.changedFiles).toContain("src/models.ts");
  });

  it("keeps advisory BLOCK non-blocking but returns 2 in pre-archive-block mode", async () => {
    const advisoryRoot = await sensitiveRoot();
    const advisory = await runMaintain({
      root: advisoryRoot.root,
      backend: advisoryRoot.backend,
      config: defaultConfig("openspec"),
      agent: new PatrolAgent("BLOCK"),
      preArchive: true
    });

    const blockingRoot = await sensitiveRoot();
    const blockingConfig: SpecMartenConfig = {
      ...defaultConfig("openspec"),
      overseer: { ...defaultConfig("openspec").overseer, blocking: "pre-archive-block" }
    };
    const blocking = await runMaintain({
      root: blockingRoot.root,
      backend: blockingRoot.backend,
      config: blockingConfig,
      agent: new PatrolAgent("BLOCK"),
      preArchive: true
    });

    expect(advisory.verdict).toBe("BLOCK");
    expect(advisory.exitCode).toBe(0);
    expect(blocking.verdict).toBe("BLOCK");
    expect(blocking.exitCode).toBe(2);
  });
});

class ThrowingAgent implements AgentRunner {
  name = "codex" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    throw new Error("agent should not be called");
  }
}

class SemanticSyncAgent implements AgentRunner {
  name = "codex" as const;

  constructor(private readonly archivedChange: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    return JSON.stringify({
      state: {
        ...createInitialState(),
        phases: [
          {
            id: "p1",
            title: "MVP",
            status: "done",
            tasks: [
              {
                id: "p1.1",
                title: "Build hunk support",
                status: "done",
                changes: [this.archivedChange],
                archivedAt: "2026-06-21"
              }
            ]
          }
        ],
        unlinkedChanges: []
      },
      notes: []
    });
  }
}

class PatrolAgent implements AgentRunner {
  name = "codex" as const;

  constructor(private readonly verdict: "PASS" | "WARN" | "BLOCK") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    return JSON.stringify({
      state: {
        ...createInitialState(),
        phases: [
          {
            id: "p1",
            title: "MVP",
            status: "done",
            tasks: [{ id: "p1.1", title: "Build hunk support", status: "done", changes: ["do-hunk"] }]
          }
        ],
        unlinkedChanges: []
      },
      patrol: {
        change: "do-hunk",
        report: `# Overseer 巡检报告 · do-hunk
## 概要
Patrol result.
## 发现
| # | 维度 | 严重度 | 位置(文件:符号) | 说明 | 建议 |
| 1 | 接口契约 | ${this.verdict} | src/models.ts:AddedModel | Finding | Review |
## 回写建议
- 无

VERDICT: ${this.verdict}
`
      },
      notes: []
    });
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-maintain-test-"));
}

async function writeProjectConfig(root: string): Promise<void> {
  await writeJson(join(root, ".specmarten.json"), defaultConfig("openspec"));
}

async function createOpenSpecWithActiveChange(root: string, id: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "hunk"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", id, "specs", "hunk"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "hunk", "spec.md"), "# Hunk Spec\n", "utf8");
  await writeFile(join(root, "openspec", "changes", id, "proposal.md"), "# Build hunk support\n", "utf8");
  await writeFile(join(root, "openspec", "changes", id, "specs", "hunk", "spec.md"), "## ADDED Requirements\n", "utf8");
}

async function writeLinkedState(root: string, changeId: string): Promise<void> {
  await writeState(root, singleStreamState({
    ...createInitialState(),
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [{ id: "p1.1", title: "Build hunk support", status: "in-progress", changes: [changeId] }]
      }
    ]));
}

async function archiveChange(root: string, archivedId: string, activeId = archivedId): Promise<void> {
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await rename(join(root, "openspec", "changes", activeId), join(root, "openspec", "changes", "archive", archivedId));
}

async function gitInit(root: string): Promise<void> {
  await runProcess("git", ["init"], { cwd: root });
}

async function sensitiveRoot(): Promise<{ root: string; backend: OpenSpecBackend }> {
  const root = await tempRoot();
  await gitInit(root);
  await createOpenSpecWithActiveChange(root, "do-hunk");
  await writeProjectConfig(root);
  await writeLinkedState(root, "do-hunk");
  const backend = new OpenSpecBackend(root);
  await writeMaintainMarker(root, await backend.getCurrentMarker());
  await archiveChange(root, "do-hunk");
  await ensureDir(join(root, "src"));
  await writeFile(join(root, "src", "models.ts"), "export class AddedModel {}\n", "utf8");
  return { root, backend };
}
