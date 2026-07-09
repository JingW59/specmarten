import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runRender } from "../core/render/render.js";

export function registerRenderCommand(program: Command): void {
  program
    .command("render")
    .description("Regenerate SpecMarten roadmap and dashboard views from specmarten/state.json.")
    .action(async () => {
      const summary = await runRender({ root: process.cwd() });
      console.log(`${TOOL.displayName} rendered generated views.`);
      console.log(`Roadmap: ${summary.roadmapPath}`);
      console.log(`Dashboard: ${summary.dashboardPath}`);
    });
}
