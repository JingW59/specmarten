import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export async function writeTextIfMissing(path: string, content: string): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }

  await writeText(path, content);
  return true;
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonIfMissing(path: string, value: unknown): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }

  await writeJson(path, value);
  return true;
}

export async function listDirectoryNames(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    return [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function listFilePathsRecursive(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFilePathsRecursive(fullPath)));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }

  return output.sort((a, b) => a.localeCompare(b));
}
