import { Command } from "commander";
import { createSpecBackend } from "../adapters/spec-backend/factory.js";
import { readConfig } from "../config/config.js";
import {
  formatStatus,
  runStatus,
  serializeStatusMaintainSignal,
  statusSummaryJson
} from "../core/status/status.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show a read-only snapshot; exits 0 unless the command fails.")
    .option("--json", "print machine-readable snapshot")
    .option("--summary-json", "print compact machine-readable status for automation")
    .action(async (options: { json?: boolean; summaryJson?: boolean }) => {
      const root = process.cwd();
      const config = await readConfig(root);
      const backend = createSpecBackend(root, config.specBackend);
      const snapshot = await runStatus({ root, backend, config });

      if (options.summaryJson) {
        console.log(JSON.stringify(statusSummaryJson(snapshot), null, 2));
      } else if (options.json) {
        console.log(
          JSON.stringify(
            {
              currentPhase: snapshot.currentPhase,
              currentStream: snapshot.currentStream,
              streams: snapshot.streams,
              doneTasks: snapshot.doneTasks,
              totalTasks: snapshot.totalTasks,
              progressPercent: snapshot.progressPercent,
              inProgressChanges: snapshot.inProgressChanges,
              lastPatrol: snapshot.lastPatrol,
              warnCount: snapshot.warnCount,
              blockCount: snapshot.blockCount,
              drift: snapshot.drift,
              lazyMaintain: serializeStatusMaintainSignal(snapshot.maintain)
            },
            null,
            2
          )
        );
      } else {
        process.stdout.write(formatStatus(snapshot));
      }

      process.exitCode = snapshot.maintain.exitCode;
    });
}
