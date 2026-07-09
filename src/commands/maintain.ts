import { Command } from "commander";
import { OpenSpecBackend } from "../adapters/spec-backend/openspec.js";
import { readConfig } from "../config/config.js";
import { TOOL } from "../constants.js";
import { refreshBaseline } from "../core/baseline.js";
import { runMaintain } from "../core/maintenance/maintain.js";
import { runReconcile } from "../core/reconcile/reconcile.js";
import {
  HEADLESS_OPTION_DESCRIPTION,
  isHeadlessRequested,
  maybeCreateHeadlessAgent,
  type HeadlessAgentFactory
} from "./execution-mode.js";

export function registerMaintainCommand(
  program: Command,
  deps: { createAgent?: HeadlessAgentFactory } = {}
): void {
  program
    .command("maintain")
    .description("Run deterministic reconcile by default; use --headless for explicit agent maintenance.")
    .option("--since <marker>", "override the stored change marker")
    .option("--accept-baseline", "refresh the accepted SpecMarten baseline after deterministic reconcile")
    .option("--no-render", "skip regenerated roadmap and dashboard views")
    .option("--json", "print machine-readable summary")
    .option("--pre-archive", "run in pre-archive mode so configured BLOCK verdicts exit 2")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .action(
      async (options: {
        since?: string;
        acceptBaseline?: boolean;
        render?: boolean;
        json?: boolean;
        preArchive?: boolean;
        headless?: boolean;
      }) => {
        const root = process.cwd();
        const backend = new OpenSpecBackend(root);
        const headless = isHeadlessRequested(options.headless || program.opts().headless);

        if (!headless) {
          const summary = await runReconcile({
            root,
            backend,
            noRender: options.render === false,
            acceptBaseline: options.acceptBaseline
          });

          if (options.json) {
            console.log(JSON.stringify({ ...summary, mode: "client-first-reconcile" }, null, 2));
          } else {
            console.log(
              `${TOOL.displayName} maintain: deterministic reconcile complete${
                summary.rendered ? ", views rendered" : ", render skipped"
              }.`
            );
            if (summary.baseline) {
              console.log(`Baseline refreshed: ${summary.baseline.specsHash} (${summary.baseline.copiedFiles} files).`);
            }
            console.log("Run `$specmarten-maintain` in Codex for semantic maintenance and drift patrol.");
            console.log(`Headless fallback: \`${TOOL.cliName} maintain --headless\` or SPECMARTEN_HEADLESS=1.`);
          }
          process.exitCode = 0;
          return;
        }

        const config = await readConfig(root);
        const agent = deps.createAgent
          ? await deps.createAgent(config.agent.prefer)
          : await maybeCreateHeadlessAgent(config.agent.prefer);
        const summary = await runMaintain({
          root,
          backend,
          config,
          agent,
          since: options.since,
          noRender: options.render === false,
          preArchive: options.preArchive
        });
        const baseline =
          options.acceptBaseline && summary.exitCode === 0
            ? await refreshBaseline({ root, backend, noRender: options.render === false })
            : undefined;

        if (options.json) {
          console.log(JSON.stringify({ ...summary, baseline }, null, 2));
        } else if (summary.earlyExit) {
          console.log(`${TOOL.displayName} maintain: no OpenSpec changes detected.`);
          if (baseline) {
            console.log(`Baseline refreshed: ${baseline.specsHash} (${baseline.copiedFiles} files).`);
          }
        } else {
          console.log(
            `${TOOL.displayName} maintain: ${summary.agentCalled ? "AI maintenance" : "local maintenance"} complete${
              summary.report ? `, patrol ${summary.verdict} (${summary.report})` : ""
            }.`
          );
          if (baseline) {
            console.log(`Baseline refreshed: ${baseline.specsHash} (${baseline.copiedFiles} files).`);
          }
        }

        process.exitCode = summary.exitCode;
      }
    );
}
