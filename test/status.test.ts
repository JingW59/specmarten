import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { defaultConfig } from "../src/config/config.js";
import { refreshBaseline } from "../src/core/baseline.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { formatStatus, runStatus } from "../src/core/status/status.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { writeJson, writeText } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("status", () => {
  it("reads status without maintaining when unchanged and formats a compact snapshot", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    await writeWarnReport(root);
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const snapshot = await runStatus({
      root,
      backend,
      config: defaultConfig()
    });
    const output = formatStatus(snapshot);

    expect(snapshot.maintain.earlyExit).toBe(true);
    expect(snapshot.maintain.needsAgent).toBe(false);
    expect(snapshot.maintain.needsReconcile).toBe(false);
    expect(snapshot.currentPhase).toBe("MVP");
    expect(snapshot.currentStream).toMatchObject({
      version: "v1",
      label: "v1",
      state: "active",
      doneTasks: 1,
      inProgressTasks: 1,
      todoTasks: 0,
      totalTasks: 2,
      progressPercent: 50,
      inProgressChanges: ["do-status"]
    });
    expect(snapshot.streams).toHaveLength(1);
    expect(snapshot.doneTasks).toBe(1);
    expect(snapshot.totalTasks).toBe(2);
    expect(snapshot.inProgressChanges).toEqual(["do-status"]);
    expect(snapshot.warnCount).toBe(1);
    expect(snapshot.drift).toEqual({
      lastPatrol: "WARN do-status",
      warnCount: 1,
      blockCount: 0
    });
    expect(output).toContain("Progress: 1/2 (50%)");
    expect(output).toContain("Current stream: v1 · v1 · active · 1/2 (50%)");
    expect(output).toContain("Streams: v1 · v1 · active · 1/2 (50%)");
    expect(output).toContain("Last patrol: WARN do-status");
  });

  it("reports read-only reconcile need without writing state or views", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    await writeText(join(root, "specmarten", "roadmap.md"), "unchanged roadmap\n");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");

    const snapshot = await runStatus({
      root,
      backend,
      config: defaultConfig()
    });
    const state = await readState(root);

    expect(snapshot.maintain.earlyExit).toBe(false);
    expect(snapshot.maintain.needsReconcile).toBe(true);
    expect(snapshot.maintain.needsAgent).toBe(false);
    expect(snapshot.maintain.agentCalled).toBe(false);
    expect(snapshot.doneTasks).toBe(1);
    expect(collectPhases(state)[0]?.tasks[1]?.status).toBe("in-progress");
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toBe("unchanged roadmap\n");

    const output = await runStatusCommand(root, ["status", "--json"]);
    const payload = JSON.parse(output.stdout);
    expect(process.exitCode).toBe(0);
    expect(payload.lazyMaintain.needsReconcile).toBe(true);
    expect(payload.lazyMaintain.needsAgent).toBe(false);
    expect(payload.lazyMaintain.triage.diffText).toBeUndefined();
    expect(payload.lazyMaintain.recommendedCommand).toBe("specmarten maintain");
  });

  it("reports read-only reconcile need when stale checklist progress has an unchanged marker", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeFile(join(root, "openspec", "changes", "do-status", "tasks.md"), "# Tasks\n\n- [x] Render status\n", "utf8");
    await writeStateForStatus(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const snapshot = await runStatus({
      root,
      backend,
      config: defaultConfig()
    });
    const state = await readState(root);

    expect(snapshot.maintain.earlyExit).toBe(false);
    expect(snapshot.maintain.needsReconcile).toBe(true);
    expect(snapshot.maintain.needsAgent).toBe(false);
    expect(snapshot.maintain.recommendedCommand).toBe("specmarten maintain");
    expect(snapshot.doneTasks).toBe(1);
    expect(snapshot.progressPercent).toBe(50);
    expect(collectPhases(state)[0]?.tasks[1]?.status).toBe("in-progress");
  });

  it("prints compact summary json for automation", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const output = await runStatusCommand(root, ["status", "--summary-json"]);
    const payload = JSON.parse(output.stdout);

    expect(payload).toEqual({
      progress: {
        doneTasks: 1,
        totalTasks: 2,
        progressPercent: 50
      },
      activeChanges: ["do-status"],
      unlinkedActiveChanges: [],
      unlinkedChanges: [],
      needsAgent: false,
      needsReconcile: false,
      recommendedCommand: null,
      changedFiles: [],
      reasons: [],
      suggestedLinks: []
    });
  });

  it("reports active OpenSpec changes that are not linked to roadmap state even with an unchanged marker", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateWithUnlinkedTask(root);
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const snapshot = await runStatus({
      root,
      backend,
      config: defaultConfig()
    });
    const output = formatStatus(snapshot);
    const json = JSON.parse((await runStatusCommand(root, ["status", "--summary-json"])).stdout);

    expect(snapshot.maintain.earlyExit).toBe(false);
    expect(snapshot.maintain.needsAgent).toBe(true);
    expect(snapshot.maintain.needsReconcile).toBe(false);
    expect(snapshot.maintain.unlinkedActiveChanges).toEqual(["do-status"]);
    expect(snapshot.maintain.recommendedCommand).toBe("$specmarten-maintain");
    expect(output).toContain("Unlinked active changes: do-status");
    expect(json).toMatchObject({
      activeChanges: ["do-status"],
      unlinkedActiveChanges: ["do-status"],
      needsAgent: true,
      recommendedCommand: "$specmarten-maintain"
    });
    expect(json.suggestedLinks[0]).toMatchObject({
      change: "do-status",
      task: "p1.2"
    });
  });

  it("suggests candidate task links for unlinked archived changes that touch the same spec", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await createArchivedChange(root, "serve-readiness", "status");

    const output = await runStatusCommand(root, ["status", "--summary-json"]);
    const payload = JSON.parse(output.stdout);

    expect(payload.unlinkedChanges).toContain("serve-readiness");
    expect(payload.unlinkedActiveChanges).toEqual([]);
    expect(payload.needsAgent).toBe(true);
    expect(payload.suggestedLinks).toEqual([
      {
        change: "serve-readiness",
        task: "p1.2",
        confidence: "high",
        reason: "same spec: status"
      }
    ]);
  });

  it("recommends closeout when archive drift also changes the accepted baseline", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await refreshBaseline({ root, backend });
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nUpdated\n", "utf8");

    const snapshot = await runStatus({
      root,
      backend,
      config: defaultConfig()
    });

    expect(snapshot.maintain.needsReconcile).toBe(true);
    expect(snapshot.maintain.recommendedCommand).toBe("specmarten closeout");
  });

  it("reports a missing OpenSpec backend instead of recommending reconcile", async () => {
    const root = await tempRoot();
    await writeJson(join(root, ".specmarten.json"), defaultConfig());
    await mkdir(join(root, "specmarten", "reports"), { recursive: true });
    await writeState(root, createInitialState());

    const snapshot = await runStatus({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig()
    });
    const output = formatStatus(snapshot);

    expect(snapshot.maintain.backendMissing).toBe(true);
    expect(snapshot.maintain.needsReconcile).toBe(false);
    expect(snapshot.maintain.recommendedCommand).toBe("specmarten init --bootstrap");
    expect(output).toContain("Maintenance signal: OpenSpec backend missing");
    expect(output).toContain("Next: specmarten init --bootstrap");
  });

  it("prints stream progress and drift summary in json output", async () => {
    const root = await tempRoot();
    await createOpenSpecWithActiveChange(root, "do-status");
    await writeStateForStatus(root, "do-status");
    await writeWarnReport(root);
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const output = await runStatusCommand(root, ["status", "--json"]);
    const payload = JSON.parse(output.stdout);

    expect(payload.currentStream).toMatchObject({
      version: "v1",
      label: "v1",
      state: "active",
      doneTasks: 1,
      inProgressTasks: 1,
      totalTasks: 2,
      progressPercent: 50,
      inProgressChanges: ["do-status"]
    });
    expect(payload.streams).toHaveLength(1);
    expect(payload.drift).toEqual({
      lastPatrol: "WARN do-status",
      warnCount: 1,
      blockCount: 0
    });
    expect(payload.doneTasks).toBe(1);
    expect(payload.progressPercent).toBe(50);
  });
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-status-test-"));
}

async function createOpenSpecWithActiveChange(root: string, id: string): Promise<void> {
  await writeJson(join(root, ".specmarten.json"), defaultConfig());
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", id, "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive", "2026-06-01-bootstrap"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n", "utf8");
  await writeFile(join(root, "openspec", "changes", id, "proposal.md"), "# Render status\n", "utf8");
  await writeFile(join(root, "openspec", "changes", id, "specs", "status", "spec.md"), "## ADDED Requirements\n", "utf8");
  await writeFile(
    join(root, "openspec", "changes", "archive", "2026-06-01-bootstrap", "proposal.md"),
    "# Bootstrap\n",
    "utf8"
  );
}

async function writeStateForStatus(root: string, changeId: string): Promise<void> {
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI"
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [
          {
            id: "p1.1",
            title: "Bootstrap",
            status: "done",
            changes: ["2026-06-01-bootstrap"],
            archivedAt: "2026-06-01"
          },
          { id: "p1.2", title: "Render status", status: "in-progress", changes: [changeId] }
        ]
      }
    ]));
  const state = await readState(root);
  await writeState(root, {
    ...state,
    lastPatrol: {
      change: changeId,
      verdict: "WARN",
      report: "reports/warn.md",
      at: "2026-06-21T00:00:00.000Z"
    }
  });
}

async function writeStateWithUnlinkedTask(root: string): Promise<void> {
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI",
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [
          {
            id: "p1.1",
            title: "Bootstrap",
            status: "done",
            changes: ["2026-06-01-bootstrap"],
            archivedAt: "2026-06-01"
          },
          { id: "p1.2", title: "Render status", status: "todo", changes: [] }
        ]
      }
    ]));
}

async function writeWarnReport(root: string): Promise<void> {
  await writeText(
    join(root, "specmarten", "reports", "warn.md"),
    `---
change: "do-status"
verdict: WARN
findings: 1
agent: codex
---
VERDICT: WARN
`
  );
}

async function archiveChange(root: string, id: string): Promise<void> {
  await rename(join(root, "openspec", "changes", id), join(root, "openspec", "changes", "archive", id));
}

async function createArchivedChange(root: string, id: string, spec: string): Promise<void> {
  await mkdir(join(root, "openspec", "changes", "archive", id, "specs", spec), { recursive: true });
  await writeFile(join(root, "openspec", "changes", "archive", id, "proposal.md"), "# Serve readiness\n", "utf8");
  await writeFile(
    join(root, "openspec", "changes", "archive", id, "specs", spec, "spec.md"),
    "## ADDED Requirements\n",
    "utf8"
  );
}

async function runStatusCommand(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
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
