import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { pathExists } from "../src/util/fs.js";

const originalPath = process.env.PATH;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  process.env.PATH = originalPath;
  process.env.CODEX_HOME = originalCodexHome;
});

describe("fallback hooks", () => {
  it("installs a deterministic non-blocking git post-commit hook", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, ".git"), { recursive: true });

    const summary = await runInit({ root, noClaude: true, noCodex: true });
    const hook = await readFile(join(root, ".git", "hooks", "post-commit"), "utf8");

    expect(summary.gitHook.installed).toBe(true);
    expect(hook).toContain("specmarten reconcile");
    expect(hook).toContain("command -v specmarten");
    expect(hook).toContain("|| true");
    expect(hook).not.toContain("specmarten maintain");
  });

  it("skips the git hook cleanly when no repository is present", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);

    const summary = await runInit({ root, noClaude: true, noCodex: true });

    expect(summary.gitHook.installed).toBe(false);
    expect(summary.gitHook.skippedReason).toBeTruthy();
    expect(await pathExists(join(root, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("installs a deterministic scoped non-blocking Claude PostToolUse hook", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, ".claude"), { recursive: true });

    const summary = await runInit({ root, noCodex: true, noGitHook: true });
    const settings = await readFile(join(root, ".claude", "settings.json"), "utf8");

    expect(summary.claude.detected).toBe(true);
    expect(settings).toContain('"PostToolUse"');
    expect(settings).toContain("specmarten reconcile");
    expect(settings).toContain("case");
    expect(settings).toContain("openspec");
    expect(settings).toContain("|| true");
    expect(settings).not.toContain("specmarten maintain");
  });

  it("installs Codex guidance without a headless hook", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const codexHome = await tempRoot();
    process.env.CODEX_HOME = codexHome;
    await createOpenSpec(root);
    await writeFakeCodex(bin);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const summary = await runInit({ root, noClaude: true, noGitHook: true });
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");

    expect(summary.codex.detected).toBe(true);
    expect(await pathExists(join(root, ".codex", "hooks.json"))).toBe(false);
    expect(agents).toContain("specmarten closeout");
    expect(agents).toContain("specmarten next");
    expect(agents).toContain("specmarten status --summary-json");
    expect(agents).toContain("$specmarten-status");
    expect(agents).toContain("read-only context");
  });

  it("keeps installed fallback hook artifacts free of headless invocations", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const codexHome = await tempRoot();
    process.env.CODEX_HOME = codexHome;
    await createOpenSpec(root);
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFakeCodex(bin);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    await runInit({ root });

    const hookArtifacts = (
      await Promise.all([
        readFile(join(root, ".git", "hooks", "post-commit"), "utf8"),
        readFile(join(root, ".claude", "settings.json"), "utf8")
      ])
    ).join("\n");
    const artifacts = `${hookArtifacts}\n${await readFile(join(root, "AGENTS.md"), "utf8")}`;

    expect(hookArtifacts).not.toContain("specmarten status --summary-json");
    expect(hookArtifacts).not.toContain("$specmarten-status");

    for (const forbidden of [
      "specmarten maintain",
      "claude -p",
      "codex exec",
      "gemini -p",
      "--headless",
      "SPECMARTEN_HEADLESS"
    ]) {
      expect(artifacts).not.toContain(forbidden);
    }
  });
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-test-"));
}

async function createOpenSpec(root: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "example"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "example", "spec.md"), "# Example Spec\n", "utf8");
}

async function writeFakeCodex(bin: string): Promise<void> {
  const codex = join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(codex, 0o755);
}
