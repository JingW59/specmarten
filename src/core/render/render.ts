import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { renderViews } from "../renderers/index.js";
import { readState } from "../state/store.js";

export interface RenderSummary {
  roadmapPath: string;
  dashboardPath: string;
}

export async function runRender(options: { root: string }): Promise<RenderSummary> {
  const state = await readState(options.root);
  await renderViews(options.root, state);

  return {
    roadmapPath: join(options.root, TOOL.dataDir, "roadmap.md"),
    dashboardPath: join(options.root, TOOL.dataDir, "dashboard.html")
  };
}
