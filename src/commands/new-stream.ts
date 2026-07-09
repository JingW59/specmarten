import { Command } from "commander";
import { TOOL } from "../constants.js";
import { runNewStream } from "../core/streams/new-stream.js";

export function registerNewStreamCommand(program: Command): void {
  program
    .command("new-stream <label>")
    .description("Create a reviewed draft for a new roadmap stream.")
    .option("--id <id>", "stream id to write; defaults to the next vN")
    .option("--stream-version <version>", "stream version to show; defaults to the next vN")
    .option("--supersedes <stream>", "stream id or version this new stream supersedes; defaults to current stream")
    .option("--parallel", "create the stream as parallel instead of superseding the current stream")
    .action(
      async (
        label: string,
        options: { id?: string; streamVersion?: string; supersedes?: string; parallel?: boolean }
      ) => {
        const summary = await runNewStream({
          root: process.cwd(),
          label,
          id: options.id,
          version: options.streamVersion,
          supersedes: options.supersedes,
          parallel: Boolean(options.parallel)
        });

        const relation =
          summary.relation === "supersedes"
            ? `supersedes ${summary.supersedes}`
            : summary.relation === "parallel"
              ? "parallel"
              : "first stream";
        console.log(`${TOOL.displayName} wrote a new stream draft: ${summary.version} · ${label} (${relation}).`);
        console.log(`State: ${summary.statePath}`);
        console.log(`Report: ${summary.reportPath}`);
        console.log(`Generated: ${TOOL.dataDir}/roadmap.md, ${TOOL.dataDir}/dashboard.html`);
        console.log(`Next: review ${TOOL.dataDir}/roadmap.md, then run \`${TOOL.cliName} promote\` when ready.`);
      }
    );
}
