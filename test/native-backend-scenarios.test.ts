import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSpecBackend, resolveSpecBackendName } from "../src/adapters/spec-backend/factory.js";
import { initializeNativeLedger, NativeSpecBackend } from "../src/adapters/spec-backend/native.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { runInit } from "../src/commands/init.js";
import { defaultConfig } from "../src/config/config.js";
import { createBaselineIfMissing } from "../src/core/baseline.js";
import { runCloseout } from "../src/core/closeout/closeout.js";
import { buildMaintainContext } from "../src/core/context/maintain-context.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { runNext } from "../src/core/next/next.js";
import { runReconcile } from "../src/core/reconcile/reconcile.js";
import { renderViews } from "../src/core/renderers/index.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { runValidate } from "../src/core/validate/validate.js";
import { pathExists, writeJson } from "../src/util/fs.js";

describe("native backend scenarios", () => {
  it("lets an explicit native selection override a pre-existing OpenSpec directory", async () => {
    const root = await tempRoot();
    await createOpenSpecLayout(root);

    await runInit({ root, backend: "native", minimal: true });

    expect(await resolveSpecBackendName(root)).toBe("native");
    expect(await pathExists(join(root, "specmarten", "ledger"))).toBe(true);
    expect(await pathExists(join(root, "openspec", "changes", "archive"))).toBe(true);
  });

  it("rejects a conflicting backend option and rejects OpenSpec bootstrap for native projects", async () => {
    const root = await tempRoot();
    await runInit({ root, backend: "native", minimal: true });

    await expect(runInit({ root, backend: "openspec", minimal: true })).rejects.toThrow(
      "already selects the native backend"
    );
    await expect(runInit({ root, bootstrap: true, minimal: true })).rejects.toThrow(
      "--bootstrap is only available with the openspec backend"
    );
  });

  it("prefers an existing OpenSpec project when both unconfigured layouts are present", async () => {
    const root = await tempRoot();
    await createOpenSpecLayout(root);
    await initializeNativeLedger(root);

    expect(await resolveSpecBackendName(root)).toBe("openspec");
    expect(createSpecBackend(root, await resolveSpecBackendName(root))).toBeInstanceOf(OpenSpecBackend);
  });

  it("keeps the pre-init no-layout fallback on OpenSpec for backward compatibility", async () => {
    expect(await resolveSpecBackendName(await tempRoot())).toBe("openspec");
  });

  it("keeps native and OpenSpec changes isolated behind the configured backend", async () => {
    const root = await tempRoot();
    await initializeNativeLedger(root);
    await createOpenSpecLayout(root);
    await createNativeChange(root, "native-search", "- [ ] Implement native search\n");
    await createOpenSpecChange(root, "openspec-login");
    await writeJson(join(root, ".specmarten.json"), defaultConfig("native"));
    await writeState(root, createInitialState());

    const nativeContext = await buildMaintainContext({ root });
    expect(nativeContext.specBackend).toBe("native");
    expect(nativeContext.ledger.activeChanges.map((change) => change.id)).toEqual(["native-search"]);

    await writeJson(join(root, ".specmarten.json"), defaultConfig("openspec"));
    const openSpecContext = await buildMaintainContext({ root });
    expect(openSpecContext.specBackend).toBe("openspec");
    expect(openSpecContext.ledger.activeChanges.map((change) => change.id)).toEqual(["openspec-login"]);
  });

  it("reconciles a linked native change from active to date-prefixed archive", async () => {
    const { root, backend } = await createNativeProject("native-search", "- [x] Define search\n- [ ] Verify search\n");

    await runReconcile({ root, backend });
    expect(collectPhases(await readState(root))[0]?.tasks[0]?.status).toBe("in-progress");

    await rename(
      join(root, "specmarten", "ledger", "changes", "native-search"),
      join(root, "specmarten", "ledger", "changes", "archive", "2026-07-12-native-search")
    );
    const summary = await runReconcile({ root, backend });
    const task = collectPhases(await readState(root))[0]?.tasks[0];

    expect(task).toMatchObject({ status: "done", changes: ["native-search"], archivedAt: "2026-07-12" });
    expect(summary.unlinkedActiveChanges).toEqual([]);
    expect(summary.unlinkedChanges).toEqual([]);
  });

  it("reports incomplete native checklists without OpenSpec-specific guidance", async () => {
    const { root, backend, config } = await createNativeProject(
      "native-search",
      "- [x] Define search\n- [ ] Verify search\n"
    );

    const validation = await runValidate({ root, backend, config, requireComplete: true });
    const issue = validation.issues.find((candidate) => candidate.code === "change-active-incomplete");

    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("Complete its tasks.md checklist");
    expect(issue?.message).not.toMatch(/OpenSpec|openspec\//);
  });

  it("uses backend-neutral machine codes for native reconciliation issues", async () => {
    const root = await tempRoot();
    await runInit({ root, backend: "native", minimal: true });
    await createNativeChange(root, "native-search", "- [x] Implement native search\n");
    await renderViews(root, await readState(root));
    const backend = new NativeSpecBackend(root);

    const validation = await runValidate({ root, backend, config: defaultConfig("native") });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "change-active-unlinked", fixCommand: "$specmarten-maintain" })
      ])
    );
    expect(validation.issues.some((issue) => issue.code.startsWith("openspec-"))).toBe(false);

    await rename(
      join(root, "specmarten", "ledger", "changes", "native-search"),
      join(root, "specmarten", "ledger", "changes", "archive", "2026-07-12-native-search")
    );
    const archivedValidation = await runValidate({ root, backend, config: defaultConfig("native") });

    expect(archivedValidation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "change-archived-unlinked" })])
    );
    expect(archivedValidation.issues.some((issue) => issue.code.startsWith("openspec-"))).toBe(false);

    const closeout = await runCloseout({ root, backend, config: defaultConfig("native") });
    expect(closeout.exitCode).toBe(1);
    expect(closeout.baseline).toBeUndefined();
    expect(closeout.blockingIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "change-archived-unlinked" })])
    );
  });

  it("recommends closeout when native accepted specs drift from the baseline", async () => {
    const { root, backend, config } = await createNativeProject("native-search", "- [x] Verify search\n");
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await writeFile(
      join(root, "specmarten", "ledger", "specs", "search", "spec.md"),
      "# Search\n\nUpdated accepted behavior.\n",
      "utf8"
    );

    const next = await runNext({ root, backend, config });

    expect(next.command).toBe("specmarten closeout");
    expect(next.reason).toContain("native ledger");
  });

  it("closes out native baseline drift even when accepted Markdown contains Purpose TBD", async () => {
    const root = await tempRoot();
    await initializeNativeLedger(root);
    const backend = new NativeSpecBackend(root);
    const config = defaultConfig("native");
    await writeJson(join(root, ".specmarten.json"), config);
    await mkdir(join(root, "specmarten", "reports"), { recursive: true });
    await mkdir(join(root, "specmarten", "ledger", "specs", "search"), { recursive: true });
    await writeFile(join(root, "specmarten", "ledger", "specs", "search", "spec.md"), "# Search\n", "utf8");
    const baseline = await createBaselineIfMissing(root, backend);
    await writeState(root, createInitialState({ baseline }));
    await renderViews(root, await readState(root));
    await writeFile(
      join(root, "specmarten", "ledger", "specs", "search", "spec.md"),
      "# Search\n\n## Purpose\nTBD\n",
      "utf8"
    );

    const summary = await runCloseout({ root, backend, config });

    expect(summary.exitCode).toBe(0);
    expect(summary.blockingIssues).toEqual([]);
    expect(summary.baseline?.copiedFiles).toBe(1);
    await expect(
      readFile(join(root, "specmarten", "baseline", "specs-snapshot", "search", "spec.md"), "utf8")
    ).resolves.toContain("TBD");
  });

  it("ignores local metadata when detecting native ledger and accepted-spec drift", async () => {
    const { root, backend } = await createNativeProject("native-search", "- [x] Verify search\n");
    const marker = await backend.getCurrentMarker();
    const specsHash = await backend.getSpecsHash();

    await writeFile(join(root, "specmarten", "ledger", ".DS_Store"), "local", "utf8");
    await writeFile(join(root, "specmarten", "ledger", "specs", ".DS_Store"), "local", "utf8");

    expect(await backend.getCurrentMarker()).toBe(marker);
    expect(await backend.getSpecsHash()).toBe(specsHash);
  });
});

async function createNativeProject(changeId: string, checklist: string): Promise<{
  root: string;
  backend: NativeSpecBackend;
  config: ReturnType<typeof defaultConfig>;
}> {
  const root = await tempRoot();
  await initializeNativeLedger(root);
  await createNativeChange(root, changeId, checklist);
  await mkdir(join(root, "specmarten", "ledger", "specs", "search"), { recursive: true });
  await mkdir(join(root, "specmarten", "reports"), { recursive: true });
  await writeFile(join(root, "specmarten", "ledger", "specs", "search", "spec.md"), "# Search\n", "utf8");
  const backend = new NativeSpecBackend(root);
  const config = defaultConfig("native");
  const baseline = await createBaselineIfMissing(root, backend);
  await writeJson(join(root, ".specmarten.json"), config);
  await writeState(
    root,
    singleStreamState(
      { ...createInitialState({ baseline }), mission: "Native backend scenarios" },
      [
        {
          id: "p1",
          title: "Native ledger",
          status: "in-progress",
          tasks: [{ id: "p1.1", title: "Native search", status: "in-progress", changes: [changeId] }]
        }
      ]
    )
  );
  await renderViews(root, await readState(root));
  return { root, backend, config };
}

async function createNativeChange(root: string, id: string, checklist: string): Promise<void> {
  const changeRoot = join(root, "specmarten", "ledger", "changes", id);
  await mkdir(join(changeRoot, "specs", "search"), { recursive: true });
  await writeFile(join(changeRoot, "proposal.md"), `# ${id}\n`, "utf8");
  await writeFile(join(changeRoot, "tasks.md"), `# Tasks\n\n${checklist}`, "utf8");
  await writeFile(join(changeRoot, "specs", "search", "spec.md"), "## ADDED Requirements\n", "utf8");
}

async function createOpenSpecLayout(root: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
}

async function createOpenSpecChange(root: string, id: string): Promise<void> {
  const changeRoot = join(root, "openspec", "changes", id);
  await mkdir(changeRoot, { recursive: true });
  await writeFile(join(changeRoot, "proposal.md"), `# ${id}\n`, "utf8");
  await writeFile(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] Implement\n", "utf8");
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-native-scenarios-"));
}
