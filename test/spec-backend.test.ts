import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSpecBackend } from "../src/adapters/spec-backend/factory.js";
import { initializeNativeLedger, NativeSpecBackend } from "../src/adapters/spec-backend/native.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { pathExists } from "../src/util/fs.js";

describe("OpenSpec backend", () => {
  it("ignores local filesystem metadata when hashing and snapshotting specs", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-backend-"));
    await mkdir(join(root, "openspec", "specs", "example"), { recursive: true });
    await writeFile(join(root, "openspec", "specs", "example", "spec.md"), "# example\n", "utf8");

    const backend = new OpenSpecBackend(root);
    const before = await backend.getSpecsHash();
    await writeFile(join(root, "openspec", "specs", ".DS_Store"), "local metadata", "utf8");

    const snapshot = await backend.snapshotSpecs(join(root, "specmarten", "baseline", "specs-snapshot"));

    expect(await backend.getSpecsHash()).toBe(before);
    expect(snapshot.specsHash).toBe(before);
    expect(snapshot.copiedFiles).toBe(1);
    expect(await readFile(join(root, "specmarten", "baseline", "specs-snapshot", "example", "spec.md"), "utf8")).toBe(
      "# example\n"
    );
    expect(await pathExists(join(root, "specmarten", "baseline", "specs-snapshot", ".DS_Store"))).toBe(false);
  });

  it("extracts archive dates from nested OpenSpec archive folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-openspec-archive-"));
    const archive = join(root, "openspec", "changes", "archive", "2026", "2026-07-01-add-login");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "proposal.md"), "# Add login\n", "utf8");

    const archived = await new OpenSpecBackend(root).listArchivedChanges();

    expect(archived).toEqual([
      expect.objectContaining({ id: "2026/2026-07-01-add-login", archivedAt: "2026-07-01" })
    ]);
  });
});

describe("native backend", () => {
  it("reads native active and archived changes through the shared backend contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-native-backend-"));
    await initializeNativeLedger(root);
    await mkdir(join(root, "specmarten", "ledger", "changes", "add-search", "specs", "search"), {
      recursive: true
    });
    await writeFile(
      join(root, "specmarten", "ledger", "changes", "add-search", "proposal.md"),
      "# Add search\n\n## Why\nUsers need search.\n",
      "utf8"
    );
    await writeFile(
      join(root, "specmarten", "ledger", "changes", "add-search", "tasks.md"),
      "# Tasks\n\n- [x] Define behavior\n- [ ] Implement behavior\n",
      "utf8"
    );
    await writeFile(
      join(root, "specmarten", "ledger", "changes", "add-search", "specs", "search", "spec.md"),
      "## ADDED Requirements\n",
      "utf8"
    );
    await mkdir(join(root, "specmarten", "ledger", "changes", "archive", "2026", "2026-07-01-add-login"), {
      recursive: true
    });
    await writeFile(
      join(root, "specmarten", "ledger", "changes", "archive", "2026", "2026-07-01-add-login", "proposal.md"),
      "# Add login\n",
      "utf8"
    );

    const backend = new NativeSpecBackend(root);
    const active = await backend.listActiveChanges();
    const archived = await backend.listArchivedChanges();
    const detail = await backend.readChange("add-search");

    expect(active).toEqual([
      expect.objectContaining({
        id: "add-search",
        status: "active",
        title: "Add search",
        specsTouched: ["search"],
        taskProgress: { completed: 1, total: 2, complete: false }
      })
    ]);
    expect(archived).toEqual([
      expect.objectContaining({ id: "2026/2026-07-01-add-login", status: "archived", archivedAt: "2026-07-01" })
    ]);
    expect(detail.specDeltas).toEqual([
      expect.objectContaining({ path: "search/spec.md", content: "## ADDED Requirements\n" })
    ]);
    expect(createSpecBackend(root, "native")).toBeInstanceOf(NativeSpecBackend);
    expect(createSpecBackend(root, "openspec")).toBeInstanceOf(OpenSpecBackend);
  });

  it("hashes and snapshots native accepted specs", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-native-specs-"));
    await initializeNativeLedger(root);
    await mkdir(join(root, "specmarten", "ledger", "specs", "search"), { recursive: true });
    await writeFile(
      join(root, "specmarten", "ledger", "specs", "search", "spec.md"),
      "# Search capability\n",
      "utf8"
    );
    const backend = new NativeSpecBackend(root);

    const snapshot = await backend.snapshotSpecs(join(root, "specmarten", "baseline", "specs-snapshot"));

    expect(snapshot.specsHash).toMatch(/^sha256:/);
    expect(snapshot.copiedFiles).toBe(1);
    await expect(
      readFile(join(root, "specmarten", "baseline", "specs-snapshot", "search", "spec.md"), "utf8")
    ).resolves.toBe("# Search capability\n");
  });
});
