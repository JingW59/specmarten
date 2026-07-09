import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
