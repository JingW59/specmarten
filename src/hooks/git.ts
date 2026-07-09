import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists, readText, writeText } from "../util/fs.js";

const START = "# >>> specmarten hook";
const END = "# <<< specmarten hook";

export interface GitHookInstallResult {
  installed: boolean;
  skippedReason?: string;
}

export async function installGitPostCommitHook(root: string): Promise<GitHookInstallResult> {
  const gitDir = join(root, ".git");
  if (!(await pathExists(gitDir))) {
    return { installed: false, skippedReason: "No .git directory detected." };
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "post-commit");
  await ensureDir(hooksDir);

  const existing = (await pathExists(hookPath)) ? await readText(hookPath) : "#!/bin/sh\n";
  if (existing.includes(START)) {
    const migrated = migrateManagedHook(existing);
    if (migrated !== existing) {
      await writeText(hookPath, migrated);
      await chmod(hookPath, 0o755);
      return { installed: true };
    }

    return { installed: false, skippedReason: "SpecMarten hook already present." };
  }

  const block = `
${START}
if command -v specmarten >/dev/null 2>&1; then
  specmarten reconcile >/dev/null 2>&1 || true
fi
${END}
`;
  await writeText(hookPath, `${existing.trimEnd()}\n${block}`);
  await chmod(hookPath, 0o755);
  return { installed: true };
}

function migrateManagedHook(content: string): string {
  const start = content.indexOf(START);
  const end = content.indexOf(END, start);

  if (start === -1 || end === -1) {
    return content;
  }

  const blockEnd = end + END.length;
  const before = content.slice(0, start);
  const block = content.slice(start, blockEnd);
  const after = content.slice(blockEnd);
  const migrated = block.replaceAll("specmarten maintain", "specmarten reconcile");

  return `${before}${migrated}${after}`;
}
