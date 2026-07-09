import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommand } from "../src/commands/doctor.js";
import { TOOL } from "../src/constants.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doctor", () => {
  it("prints CLI provenance as json", async () => {
    let stdout = "";
    const log = vi.spyOn(console, "log").mockImplementation((...chunks: unknown[]) => {
      stdout += `${chunks.join(" ")}\n`;
    });
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "specmarten", "doctor", "--json"], { from: "node" });
    log.mockRestore();

    const payload = JSON.parse(stdout);
    expect(payload.version).toBe(TOOL.version);
    expect(payload.packagePath).toContain("specmarten");
    expect(payload).toHaveProperty("commitHash");
    expect(payload).toHaveProperty("gitRemote");
    expect(payload).toHaveProperty("buildTime");
  });
});
