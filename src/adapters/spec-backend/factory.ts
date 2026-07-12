import { join } from "node:path";
import { hasConfig, readConfig, type SpecBackendName } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { pathExists } from "../../util/fs.js";
import { NativeSpecBackend } from "./native.js";
import { OpenSpecBackend } from "./openspec.js";
import type { SpecBackend } from "./types.js";

export function createSpecBackend(root: string, name: SpecBackendName): SpecBackend {
  return name === "native" ? new NativeSpecBackend(root) : new OpenSpecBackend(root);
}

export async function resolveSpecBackendName(root: string): Promise<SpecBackendName> {
  if (await hasConfig(root)) return (await readConfig(root)).specBackend;
  if (await pathExists(join(root, "openspec"))) return "openspec";
  if (await pathExists(join(root, TOOL.dataDir, "ledger"))) return "native";
  return "openspec";
}
