import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/util/process.js";

const SUBPROCESS_HELP_TIMEOUT_MS = 15_000;

describe("CLI help", () => {
  it("keeps top-level help focused", async () => {
    const root = process.cwd();
    const help = await runCli(root, ["--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("init [options]");
    expect(help.stdout).toContain("status [options]");
    expect(help.stdout).toContain("closeout [options]");
    expect(help.stdout).not.toMatch(/^\s+context\b/m);
    expect(help.stdout).not.toMatch(/^\s+state\b/m);
    expect(help.stdout).not.toMatch(/^\s+render\b/m);
    expect(help.stdout).not.toMatch(/^\s+reconcile\b/m);
    expect(help.stdout).not.toMatch(/^\s+baseline\b/m);
    expect(help.stdout).not.toMatch(/^\s+patrol\b/m);
  });

  it(
    "keeps advanced commands callable",
    async () => {
      const root = process.cwd();
      for (const command of ["context", "state", "render", "reconcile", "baseline", "patrol"]) {
        const advanced = await runCli(root, [command, "--help"]);
        expect(advanced.code, command).toBe(0);
        expect(advanced.stdout, command).toContain(`Usage: specmarten ${command}`);
      }
    },
    SUBPROCESS_HELP_TIMEOUT_MS
  );

  it("advertises served dashboard mode without promoting build-only mode", async () => {
    const root = process.cwd();

    const dashboard = await runCli(root, ["dashboard", "--help"]);
    expect(dashboard.code).toBe(0);
    expect(dashboard.stdout).toContain("--serve");
    expect(dashboard.stdout).not.toContain("--build");
  });
});

function runCli(root: string, args: string[]) {
  const tsx = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  return runProcess(tsx, [join(root, "src", "index.ts"), ...args], { cwd: root });
}
