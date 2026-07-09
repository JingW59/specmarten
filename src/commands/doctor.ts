import { Command } from "commander";
import { formatDoctor, runDoctor } from "../core/doctor/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Show SpecMarten CLI provenance for multi-checkout environments.")
    .option("--json", "print machine-readable provenance")
    .action(async (options: { json?: boolean }) => {
      const summary = await runDoctor();

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        process.stdout.write(formatDoctor(summary));
      }
    });
}
