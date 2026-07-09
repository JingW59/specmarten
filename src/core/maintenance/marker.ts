import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { pathExists, readJson, writeJson } from "../../util/fs.js";

export interface MaintainMarker {
  marker: string;
  updatedAt: string;
}

export function markerPath(root: string): string {
  return join(root, TOOL.dataDir, ".cache", "maintain-marker.json");
}

export async function readMaintainMarker(root: string): Promise<string | undefined> {
  const path = markerPath(root);
  if (!(await pathExists(path))) {
    return undefined;
  }

  return (await readJson<MaintainMarker>(path)).marker;
}

export async function writeMaintainMarker(root: string, marker: string): Promise<void> {
  await writeJson(markerPath(root), {
    marker,
    updatedAt: new Date().toISOString()
  } satisfies MaintainMarker);
}
