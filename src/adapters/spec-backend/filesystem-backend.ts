import { cp, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { hashDirectory } from "../../util/hash.js";
import { isLocalMetadataFile } from "../../util/local-metadata.js";
import { listDirectoryNames, listFilePathsRecursive, pathExists, readText } from "../../util/fs.js";
import type { ChangeDetail, ChangeMeta, ChangeTaskProgress, SpecBackend, SpecMeta, SpecsSnapshot } from "./types.js";

/**
 * Shared filesystem implementation of the SpecMarten change-ledger backend.
 *
 * Native and OpenSpec projects use identical on-disk layouts beneath their
 * respective roots (changes/, archive/, specs/). The only divergence between
 * the two backends is how the root directory is computed, expressed here as a
 * single abstract getter. Subclasses set `kind` for backend discrimination.
 */
export abstract class FilesystemSpecBackend implements SpecBackend {
  abstract readonly kind: "native" | "openspec";

  constructor(protected readonly root: string) {}

  /** Absolute path of the ledger root (e.g. specmarten/ledger or openspec). */
  protected abstract ledgerRoot(): string;

  async isPresent(): Promise<boolean> {
    return pathExists(this.ledgerRoot());
  }

  async listActiveChanges(): Promise<ChangeMeta[]> {
    const changeNames = (await listDirectoryNames(this.changesRoot())).filter((name) => name !== "archive");
    return Promise.all(changeNames.map((id) => this.readChangeMeta(id, "active")));
  }

  async listArchivedChanges(): Promise<ChangeMeta[]> {
    if (!(await pathExists(this.archiveRoot()))) {
      return [];
    }

    const archiveIds = await this.listArchivedChangeIds(this.archiveRoot());
    return Promise.all(archiveIds.map((id) => this.readChangeMeta(id, "archived")));
  }

  async readChange(id: string): Promise<ChangeDetail> {
    const status = (await pathExists(this.changePath(id, "active"))) ? "active" : "archived";
    const changePath = this.changePath(id, status);
    const specDeltas = await this.readSpecDeltas(join(changePath, "specs"));
    const [proposal, tasks] = await Promise.all([
      this.readOptional(join(changePath, "proposal.md")),
      this.readOptional(join(changePath, "tasks.md"))
    ]);

    return {
      ...(await this.readChangeMeta(id, status)),
      proposal,
      tasks,
      specDeltas
    };
  }

  async listSpecs(): Promise<SpecMeta[]> {
    const specsRoot = this.specsRoot();
    const files = await listFilePathsRecursive(specsRoot);
    return files.map((file) => ({
      id: relative(specsRoot, file),
      path: file
    }));
  }

  async getCurrentMarker(): Promise<string> {
    return hashDirectory(this.ledgerRoot());
  }

  async getSpecsHash(): Promise<string> {
    return hashDirectory(this.specsRoot());
  }

  async snapshotSpecs(destination: string): Promise<SpecsSnapshot> {
    await rm(destination, { recursive: true, force: true });

    if (await pathExists(this.specsRoot())) {
      await cp(this.specsRoot(), destination, {
        recursive: true,
        filter: async (source) => !isLocalMetadataFile(source)
      });
    }

    const specsHash = await this.getSpecsHash();
    const copiedFiles = (await listFilePathsRecursive(destination)).length;
    return { specsHash, copiedFiles };
  }

  async hasChangedSince(marker?: string): Promise<boolean> {
    const current = await this.getCurrentMarker();
    return marker ? current !== marker : true;
  }

  protected changesRoot(): string {
    return join(this.ledgerRoot(), "changes");
  }

  protected archiveRoot(): string {
    return join(this.changesRoot(), "archive");
  }

  protected specsRoot(): string {
    return join(this.ledgerRoot(), "specs");
  }

  protected changePath(id: string, status: "active" | "archived"): string {
    return status === "active" ? join(this.changesRoot(), id) : join(this.archiveRoot(), id);
  }

  private async readChangeMeta(id: string, status: "active" | "archived"): Promise<ChangeMeta> {
    const changePath = this.changePath(id, status);
    const [proposal, tasks] = await Promise.all([
      this.readOptional(join(changePath, "proposal.md")),
      this.readOptional(join(changePath, "tasks.md"))
    ]);

    return {
      id,
      status,
      title: this.extractTitle(proposal) ?? id,
      archivedAt: status === "archived" ? this.extractArchiveDate(id) : undefined,
      specsTouched: await this.listSpecDeltaRoots(join(changePath, "specs")),
      taskProgress: this.parseTaskProgress(tasks)
    };
  }

  private async listArchivedChangeIds(root: string, prefix = ""): Promise<string[]> {
    const names = await listDirectoryNames(root);
    const output: string[] = [];

    for (const name of names) {
      const id = prefix ? `${prefix}/${name}` : name;
      const fullPath = join(root, name);
      const hasChangeFiles =
        (await pathExists(join(fullPath, "proposal.md"))) ||
        (await pathExists(join(fullPath, "tasks.md"))) ||
        (await pathExists(join(fullPath, "specs")));

      if (hasChangeFiles) {
        output.push(id);
      } else {
        output.push(...(await this.listArchivedChangeIds(fullPath, id)));
      }
    }

    return output.sort((a, b) => a.localeCompare(b));
  }

  private async readSpecDeltas(specDeltaRoot: string): Promise<Array<{ path: string; content: string }>> {
    const files = await listFilePathsRecursive(specDeltaRoot);
    return Promise.all(
      files.map(async (file) => ({
        path: relative(specDeltaRoot, file),
        content: await readText(file)
      }))
    );
  }

  private async listSpecDeltaRoots(specDeltaRoot: string): Promise<string[]> {
    return (await listDirectoryNames(specDeltaRoot)).map((name) => basename(name));
  }

  private async readOptional(path: string): Promise<string | undefined> {
    return (await pathExists(path)) ? readText(path) : undefined;
  }

  private extractTitle(markdown?: string): string | undefined {
    if (!markdown) {
      return undefined;
    }

    const heading = markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "));
    return heading?.replace(/^#\s+/, "").trim();
  }

  private extractArchiveDate(id: string): string | undefined {
    const name = id.slice(id.lastIndexOf("/") + 1);
    const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1];
  }

  private parseTaskProgress(markdown?: string): ChangeTaskProgress | undefined {
    if (!markdown) {
      return undefined;
    }

    const checkboxes = [...markdown.matchAll(/^\s*[-*]\s+\[([ xX])\]/gm)];
    if (checkboxes.length === 0) {
      return undefined;
    }

    const completed = checkboxes.filter((match) => match[1]?.toLowerCase() === "x").length;
    return {
      completed,
      total: checkboxes.length,
      complete: completed === checkboxes.length
    };
  }
}
