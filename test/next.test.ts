import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig } from "../src/config/config.js";
import { refreshBaseline } from "../src/core/baseline.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { runNext } from "../src/core/next/next.js";
import { runReconcile } from "../src/core/reconcile/reconcile.js";
import { renderViews } from "../src/core/renderers/index.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { writeJson } from "../src/util/fs.js";

describe("next", () => {
  it("recommends promote before other work when a draft exists", async () => {
    const root = await createProject("do-status");
    const state = await readState(root);
    await writeState(root, { ...state, draft: true, draftKind: "plan" });

    const next = await runNext({ root, backend: new OpenSpecBackend(root), config: defaultConfig() });

    expect(next.command).toBe("specmarten promote");
  });

  it("recommends bootstrapping OpenSpec when the backend is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-next-missing-backend-test-"));
    await writeJson(join(root, ".specmarten.json"), defaultConfig());
    await mkdir(join(root, "specmarten", "reports"), { recursive: true });
    await writeState(root, createInitialState());

    const next = await runNext({ root, backend: new OpenSpecBackend(root), config: defaultConfig() });

    expect(next.command).toBe("specmarten init --bootstrap");
  });

  it("recommends validating an active OpenSpec change when state is otherwise clean", async () => {
    const root = await createProject("do-status");
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const next = await runNext({ root, backend, config: defaultConfig() });

    expect(next.command).toBe("openspec validate do-status --strict");
  });

  it("still recommends active change validation after complete checklist progress reaches done", async () => {
    const root = await createProject("do-status");
    await writeFile(join(root, "openspec", "changes", "do-status", "tasks.md"), "# Tasks\n\n- [x] Render status\n", "utf8");
    const backend = new OpenSpecBackend(root);
    await runReconcile({ root, backend });

    const next = await runNext({ root, backend, config: defaultConfig() });
    const state = await readState(root);

    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");
    expect(next.command).toBe("openspec validate do-status --strict");
  });

  it("recommends maintain when OpenSpec changed after archive", async () => {
    const root = await createProject("do-status");
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await rename(join(root, "openspec", "changes", "do-status"), join(root, "openspec", "changes", "archive", "do-status"));

    const next = await runNext({ root, backend, config: defaultConfig() });

    expect(next.command).toBe("specmarten maintain");
  });

  it("recommends closeout when the accepted specs baseline drifted", async () => {
    const root = await createProject("do-status");
    const backend = new OpenSpecBackend(root);
    await refreshBaseline({ root, backend });
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nUpdated\n", "utf8");
    await renderViews(root, await readState(root));
    await writeMaintainMarker(root, await backend.getCurrentMarker());

    const next = await runNext({ root, backend, config: defaultConfig() });

    expect(next.command).toBe("specmarten closeout");
  });
});

async function createProject(changeId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-next-test-"));
  await writeJson(join(root, ".specmarten.json"), defaultConfig());
  await mkdir(join(root, "specmarten", "reports"), { recursive: true });
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", changeId, "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n", "utf8");
  await writeFile(join(root, "openspec", "changes", changeId, "proposal.md"), "# Render status\n", "utf8");
  await writeFile(join(root, "openspec", "changes", changeId, "specs", "status", "spec.md"), "## ADDED Requirements\n", "utf8");
  await writeState(
    root,
    singleStreamState(
      {
        ...createInitialState(),
        mission: "Status CLI"
      },
      [
        {
          id: "p1",
          title: "MVP",
          status: "in-progress",
          tasks: [{ id: "p1.1", title: "Render status", status: "in-progress", changes: [changeId] }]
        }
      ]
    )
  );
  return root;
}
