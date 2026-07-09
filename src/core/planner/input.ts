import { join, relative } from "node:path";
import { TOOL } from "../../constants.js";
import { listFilePathsRecursive, pathExists, readText } from "../../util/fs.js";
import type { SpecMartenState } from "../state/schema.js";
import { createInitialState, readState } from "../state/store.js";

export interface PlanGlobalDocs {
  missionDoc: string;
  techStackDoc: string;
  standardsDocs: Array<{ path: string; content: string }>;
}

export async function readExistingOrInitial(root: string): Promise<SpecMartenState> {
  try {
    return await readState(root);
  } catch {
    return createInitialState();
  }
}

export async function readGlobalDocs(root: string): Promise<PlanGlobalDocs> {
  const specmartenRoot = join(root, TOOL.dataDir);
  const standardsRoot = join(specmartenRoot, "standards");
  const standardsFiles = await listFilePathsRecursive(standardsRoot);

  return {
    missionDoc: await readOptional(join(specmartenRoot, "mission.md")),
    techStackDoc: await readOptional(join(specmartenRoot, "tech-stack.md")),
    standardsDocs: await Promise.all(
      standardsFiles.map(async (file) => ({
        path: relative(specmartenRoot, file),
        content: await readText(file)
      }))
    )
  };
}

async function readOptional(path: string): Promise<string> {
  return (await pathExists(path)) ? readText(path) : "";
}
