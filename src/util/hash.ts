import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { listFilePathsRecursive, pathExists } from "./fs.js";
import { isLocalMetadataFile } from "./local-metadata.js";

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  if (!(await pathExists(root))) {
    return `sha256:${hash.digest("hex")}`;
  }

  const files = (await listFilePathsRecursive(root)).filter((file) => !isLocalMetadataFile(file));
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}
