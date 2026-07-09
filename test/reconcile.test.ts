import { mkdir, mkdtemp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReconcileCommand } from "../src/commands/reconcile.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { readMaintainMarker } from "../src/core/maintenance/marker.js";
import { runReconcile } from "../src/core/reconcile/reconcile.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { commandExists, runProcess } from "../src/util/process.js";
import { writeText } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("reconcile", () => {
  it("marks a linked active change done when its checklist is complete", async () => {
    const root = await createProject();
    const backend = new OpenSpecBackend(root);

    await runReconcile({ root, backend });
    const state = await readState(root);
    const task = collectPhases(state)[0]?.tasks[0];

    expect(task).toMatchObject({
      status: "done",
      changes: ["do-status"]
    });
    expect(task?.archivedAt).toBeUndefined();
  });

  it("keeps a linked active change in progress when its checklist is partial", async () => {
    const root = await createProject();
    await writeText(join(root, "openspec", "changes", "do-status", "tasks.md"), "# Tasks\n\n- [x] Define status\n- [ ] Render status\n");
    const backend = new OpenSpecBackend(root);

    await runReconcile({ root, backend });
    const state = await readState(root);

    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "in-progress",
      changes: ["do-status"]
    });
  });

  it("keeps a multi-change task in progress until every linked checklist is complete", async () => {
    const root = await createProject();
    await createActiveChange(root, "wire-status", "# Tasks\n\n- [x] Wire status\n- [ ] Verify status\n");
    const state = await readState(root);
    const task = collectPhases(state)[0]!.tasks[0]!;
    await writeState(root, singleStreamState({
      ...state,
    }, [
        {
          id: "p1",
          title: "MVP",
          status: "in-progress",
          tasks: [{ ...task, changes: ["do-status", "wire-status"] }]
        }
      ]));
    const backend = new OpenSpecBackend(root);

    await runReconcile({ root, backend });
    expect(collectPhases(await readState(root))[0]?.tasks[0]).toMatchObject({
      status: "in-progress",
      changes: ["do-status", "wire-status"]
    });
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain("0%");

    await writeText(join(root, "openspec", "changes", "wire-status", "tasks.md"), "# Tasks\n\n- [x] Wire status\n- [x] Verify status\n");
    await runReconcile({ root, backend });

    expect(collectPhases(await readState(root))[0]?.tasks[0]).toMatchObject({
      status: "done",
      changes: ["do-status", "wire-status"]
    });
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain("100%");
  });

  it("runs deterministic reconciliation, writes state, renders views, and updates the marker", async () => {
    const root = await createProject();
    await archiveChange(root, "do-status");
    const backend = new OpenSpecBackend(root);

    const summary = await runReconcile({ root, backend });
    const state = await readState(root);

    expect(summary.rendered).toBe(true);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "done",
      changes: ["do-status"]
    });
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain("[x] Render status");
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain("Render status");
    await expect(readMaintainMarker(root)).resolves.toBe(await backend.getCurrentMarker());
  });

  it("records unlinked active changes so status and dashboard can show them", async () => {
    const root = await createProject();
    await createActiveChange(root, "wire-status", "# Tasks\n\n- [ ] Wire status\n");
    const backend = new OpenSpecBackend(root);

    const summary = await runReconcile({ root, backend });
    const state = await readState(root);

    expect(summary.unlinkedActiveChanges).toEqual(["wire-status"]);
    expect(state.unlinkedActiveChanges).toEqual(["wire-status"]);
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain("### Active");
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain("wire-status");
  });

  it("keeps unlinked archived changes separate from active changes", async () => {
    const root = await createProject();
    await createActiveChange(root, "stray-archive", "# Tasks\n\n- [x] Archive stray\n");
    await archiveChange(root, "stray-archive");
    const backend = new OpenSpecBackend(root);

    const summary = await runReconcile({ root, backend });
    const state = await readState(root);

    expect(summary.unlinkedActiveChanges).toEqual([]);
    expect(summary.unlinkedChanges).toEqual(["stray-archive"]);
    expect(state.unlinkedChanges).toEqual(["stray-archive"]);
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain("### Archived");
  });

  it("exposes a reconcile command with machine-readable output", async () => {
    const root = await createProject();
    await archiveChange(root, "do-status");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerReconcileCommand(program);
    process.chdir(root);

    await program.parseAsync(["node", "specmarten", "reconcile", "--json"], { from: "node" });

    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Awaited<ReturnType<typeof runReconcile>>;
    expect(output.rendered).toBe(true);
    expect(output.phases).toBe(1);
    expect(output.tasks).toBe(1);
  });

  it("marks a task done after native OpenSpec archive adds a date prefix", async () => {
    if (!(await commandExists("openspec"))) {
      return;
    }

    const root = await createProject();
    const archive = await runProcess("openspec", ["archive", "do-status", "--yes"], { cwd: root });
    expect(archive.code).toBe(0);
    const backend = new OpenSpecBackend(root);
    const archivedChange = (await backend.listArchivedChanges()).find((change) => change.id.endsWith("do-status"));

    await runReconcile({ root, backend });
    const state = await readState(root);
    const task = collectPhases(state)[0]?.tasks[0];

    expect(archivedChange?.id).toMatch(/^\d{4}-\d{2}-\d{2}-do-status$/);
    expect(task).toMatchObject({
      status: "done",
      changes: ["do-status"],
      archivedAt: archivedChange?.archivedAt
    });
    expect(state.unlinkedChanges).not.toContain(archivedChange?.id);
  });

  it("keeps reconcile away from headless agent imports", async () => {
    const sources = await Promise.all(
      ["src/commands/reconcile.ts", "src/core/reconcile/reconcile.ts", "src/core/maintenance/reconcile.ts"].map((file) =>
        readFile(join(process.cwd(), file), "utf8")
      )
    );

    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-reconcile-test-"));
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "do-status", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeText(
    join(root, "openspec", "specs", "status", "spec.md"),
    "# status Specification\n\n## Purpose\nTrack status behavior.\n\n## Requirements\n"
  );
  await writeText(
    join(root, "openspec", "changes", "do-status", "proposal.md"),
    "## Why\nNeed a clear status view for users and automation tests.\n\n## What Changes\n- Add status rendering.\n"
  );
  await writeText(join(root, "openspec", "changes", "do-status", "tasks.md"), "# Tasks\n\n- [x] Render status\n");
  await writeText(
    join(root, "openspec", "changes", "do-status", "specs", "status", "spec.md"),
    [
      "## ADDED Requirements",
      "",
      "### Requirement: Status",
      "",
      "The system SHALL render status.",
      "",
      "#### Scenario: Render",
      "- **WHEN** status runs",
      "- **THEN** it SHALL render",
      ""
    ].join("\n")
  );
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI",
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [{ id: "p1.1", title: "Render status", status: "in-progress", changes: ["do-status"] }]
      }
    ]));
  return root;
}

async function createActiveChange(root: string, id: string, tasks: string): Promise<void> {
  await mkdir(join(root, "openspec", "changes", id, "specs", "status"), { recursive: true });
  await writeText(join(root, "openspec", "changes", id, "proposal.md"), `# ${id}\n`);
  await writeText(join(root, "openspec", "changes", id, "tasks.md"), tasks);
  await writeText(
    join(root, "openspec", "changes", id, "specs", "status", "spec.md"),
    [
      "## ADDED Requirements",
      "",
      `### Requirement: ${id}`,
      "",
      "The system SHALL keep linked progress accurate.",
      "",
      "#### Scenario: Progress",
      "- **WHEN** status runs",
      "- **THEN** progress SHALL be accurate",
      ""
    ].join("\n")
  );
}

async function archiveChange(root: string, id: string): Promise<void> {
  await rename(join(root, "openspec", "changes", id), join(root, "openspec", "changes", "archive", id));
}
