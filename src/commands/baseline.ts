import { Command } from "commander";
import { OpenSpecBackend } from "../adapters/spec-backend/openspec.js";
import { TOOL } from "../constants.js";
import { refreshBaseline } from "../core/baseline.js";

export function registerBaselineCommand(program: Command): void {
  const baseline = program.command("baseline").description("Manage the accepted SpecMarten OpenSpec baseline.");

  baseline
    .command("refresh")
    .description("Accept current OpenSpec specs as the new SpecMarten baseline.")
    .option("--no-render", "skip regenerated roadmap and dashboard views")
    .option("--json", "print machine-readable baseline refresh summary")
    .action(async (options: { render?: boolean; json?: boolean }) => {
      const root = process.cwd();
      const summary = await refreshBaseline({
        root,
        backend: new OpenSpecBackend(root),
        noRender: options.render === false
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`${TOOL.displayName} baseline refreshed.`);
      console.log(`Specs hash: ${summary.specsHash}`);
      console.log(`Copied files: ${summary.copiedFiles}`);
      console.log(`Views rendered: ${summary.rendered ? "yes" : "no"}`);
    });
}
