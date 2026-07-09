import { join } from "node:path";
import { claudeSettingsTemplate, claudeTemplateFiles } from "../templates/index.js";
import { ensureDir, pathExists, readJson, writeJson, writeTextIfMissing } from "../util/fs.js";

export interface ClaudeInstallResult {
  detected: boolean;
  filesWritten: string[];
}

export async function installClaudeCodeFiles(root: string): Promise<ClaudeInstallResult> {
  const claudeDir = join(root, ".claude");
  if (!(await pathExists(claudeDir))) {
    return { detected: false, filesWritten: [] };
  }

  const filesWritten: string[] = [];
  await ensureDir(join(claudeDir, "agents"));
  await ensureDir(join(claudeDir, "commands"));

  for (const [relativePath, content] of Object.entries(claudeTemplateFiles)) {
    const target = join(claudeDir, relativePath);
    if (await writeTextIfMissing(target, content)) {
      filesWritten.push(relativePath);
    }
  }
  if (await installSettingsHook(claudeDir)) {
    filesWritten.push("settings.json");
  }

  return { detected: true, filesWritten };
}

async function installSettingsHook(claudeDir: string): Promise<boolean> {
  const settingsPath = join(claudeDir, "settings.json");
  if (!(await pathExists(settingsPath))) {
    await writeJson(settingsPath, claudeSettingsTemplate);
    return true;
  }

  const existing = await readJson<Record<string, unknown>>(settingsPath);
  const migrated = replaceMaintainHook(existing);
  if (JSON.stringify(migrated) !== JSON.stringify(existing)) {
    await writeJson(settingsPath, migrated);
    return true;
  }
  if (JSON.stringify(existing).includes("specmarten reconcile")) {
    return false;
  }

  const hooks = typeof existing.hooks === "object" && existing.hooks !== null ? existing.hooks : {};
  const postToolUse = Array.isArray((hooks as { PostToolUse?: unknown }).PostToolUse)
    ? ([...(hooks as { PostToolUse: unknown[] }).PostToolUse] as unknown[])
    : [];
  postToolUse.push(claudeSettingsTemplate.hooks.PostToolUse[0]);
  await writeJson(settingsPath, {
    ...existing,
    hooks: {
      ...hooks,
      PostToolUse: postToolUse
    }
  });
  return true;
}

function replaceMaintainHook(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\bspecmarten\s+maintain\b/g, "specmarten reconcile");
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceMaintainHook(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceMaintainHook(item)]));
  }

  return value;
}
