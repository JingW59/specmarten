import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArchive } from "../src/core/archive/archive.js";
import { initializeNativeLedger, NativeSpecBackend } from "../src/adapters/spec-backend/native.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { UserFacingError } from "../src/util/errors.js";
import { pathExists } from "../src/util/fs.js";

async function createNativeChange(root: string, id: string): Promise<void> {
  const changeRoot = join(root, "specmarten", "ledger", "changes", id);
  await mkdir(join(changeRoot, "specs", "search"), { recursive: true });
  await writeFile(join(changeRoot, "proposal.md"), `# ${id}\n`, "utf8");
  await writeFile(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] Done\n", "utf8");
  await writeFile(join(changeRoot, "specs", "search", "spec.md"), "## ADDED Requirements\n", "utf8");
}

describe("runArchive (native backend)", () => {
  it("moves an active change into the date-prefixed archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-"));
    await initializeNativeLedger(root);
    await createNativeChange(root, "add-login");
    const backend = new NativeSpecBackend(root);

    const summary = await runArchive({ root, backend, changeId: "add-login", date: "2026-07-12" });

    expect(summary).toEqual({
      changeId: "add-login",
      archivedTo: "2026-07-12-add-login",
      archivedAt: "2026-07-12"
    });
    // active path no longer exists
    expect(await pathExists(join(root, "specmarten", "ledger", "changes", "add-login"))).toBe(false);
    // archived path holds the change files
    const archived = await backend.listArchivedChanges();
    expect(archived).toEqual([
      expect.objectContaining({ id: "2026-07-12-add-login", status: "archived", archivedAt: "2026-07-12" })
    ]);
    // active list is now empty
    expect(await backend.listActiveChanges()).toEqual([]);
  });

  it("rejects a non-native backend with a clear message", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-openspec-"));
    const backend = new OpenSpecBackend(root);

    await expect(runArchive({ root, backend, changeId: "add-login", date: "2026-07-12" })).rejects.toThrow(
      UserFacingError
    );
    await expect(runArchive({ root, backend, changeId: "add-login", date: "2026-07-12" })).rejects.toThrow(
      /native backend/
    );
  });

  it("throws when the active change does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-missing-"));
    await initializeNativeLedger(root);
    const backend = new NativeSpecBackend(root);

    await expect(runArchive({ root, backend, changeId: "nope", date: "2026-07-12" })).rejects.toThrow(
      /not found at/
    );
  });

  it("refuses to overwrite an existing archived change", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-collision-"));
    await initializeNativeLedger(root);
    await createNativeChange(root, "add-login");
    // pre-create the target archive entry
    const targetDir = join(root, "specmarten", "ledger", "changes", "archive", "2026-07-12-add-login");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "proposal.md"), "# existing\n", "utf8");
    const backend = new NativeSpecBackend(root);

    await expect(runArchive({ root, backend, changeId: "add-login", date: "2026-07-12" })).rejects.toThrow(
      /already exists/
    );
  });

  it("rejects a malformed --date", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-baddate-"));
    await initializeNativeLedger(root);
    await createNativeChange(root, "add-login");
    const backend = new NativeSpecBackend(root);

    await expect(runArchive({ root, backend, changeId: "add-login", date: "07-12-2026" })).rejects.toThrow(
      /YYYY-MM-DD/
    );
  });

  it("defaults the archive date to today (UTC) when none is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-archive-today-"));
    await initializeNativeLedger(root);
    await createNativeChange(root, "add-login");
    const backend = new NativeSpecBackend(root);
    const today = new Date().toISOString().slice(0, 10);

    const summary = await runArchive({ root, backend, changeId: "add-login" });

    expect(summary.archivedAt).toBe(today);
    expect(summary.archivedTo).toBe(`${today}-add-login`);
  });
});
