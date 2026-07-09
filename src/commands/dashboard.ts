import { Command, Option } from "commander";
import { readConfig } from "../config/config.js";
import { TOOL } from "../constants.js";
import { runDashboard } from "../core/dashboard/dashboard.js";

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Render the read-only SpecMarten HTML dashboard.")
    .addOption(new Option("--build", "only build specmarten/dashboard.html without opening it").hideHelp())
    .option("--serve", "serve the dashboard locally with writable preferences")
    .option("--port <port>", "port for --serve; defaults to a free local port")
    .action(async (options: { build?: boolean; serve?: boolean; port?: string }) => {
      const root = process.cwd();
      const config = await readConfig(root);
      const summary = await runDashboard({
        root,
        config,
        buildOnly: options.build,
        serve: options.serve,
        port: parsePort(options.port)
      });
      console.log(`${TOOL.displayName} dashboard built: ${summary.dashboardPath}`);
      if (summary.url) {
        console.log(`${TOOL.displayName} dashboard serving: ${summary.url}`);
      }
    });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535.");
  }

  return port;
}
