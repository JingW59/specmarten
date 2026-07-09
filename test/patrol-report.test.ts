import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPatrolCommand, type PatrolCommandIO } from "../src/commands/patrol.js";
import { writePatrolReport } from "../src/core/overseer/patrol.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { listFilePathsRecursive } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.useRealTimers();
});

describe("patrol report", () => {
  it.each([
    ["PASS", 0],
    ["WARN", 10],
    ["BLOCK", 2]
  ] as const)("writes a %s report and maps the exit code", async (verdict, exitCode) => {
    const root = await createProject();

    const result = await runPatrolCommand(root, JSON.stringify({ change: "do-status", report: reportBody(verdict) }));
    const state = await readState(root);
    const reportPath = join(root, "specmarten", state.lastPatrol!.report);
    const report = await readFile(reportPath, "utf8");

    expect(process.exitCode).toBe(exitCode);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Verdict: ${verdict}`);
    expect(state.lastPatrol).toMatchObject({
      change: "do-status",
      verdict
    });
    expect(report).toContain(`verdict: ${verdict}`);
    expect(report).toContain("agent: client-session");
    expect(report).toContain(`VERDICT: ${verdict}`);
  });

  it("returns structured stderr for bad input and does not write partial state or reports", async () => {
    const root = await createProject();
    const originalState = await readState(root);

    const result = await runPatrolCommand(root, JSON.stringify({ change: "do-status" }));
    const body = JSON.parse(result.stderr) as {
      error: string;
      issues: Array<{ path: Array<string | number> }>;
    };

    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(body.error).toBe("invalid_patrol_schema");
    expect(body.issues.some((issue) => issue.path.join(".") === "report")).toBe(true);
    expect(await readState(root)).toEqual(originalState);
    expect(await listFilePathsRecursive(join(root, "specmarten", "reports"))).toEqual([]);
  });

  it("preserves same-change reports written at the same timestamp", async () => {
    const root = await createProject();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T01:02:03.456Z"));

    const first = await writePatrolReport({ root, change: "do-status", reportBody: reportBody("PASS") });
    const second = await writePatrolReport({ root, change: "do-status", reportBody: reportBody("WARN") });

    expect(first.reportRelativePath).toBe("reports/20260709T010203456Z-do-status.md");
    expect(second.reportRelativePath).toBe("reports/20260709T010203456Z-do-status-2.md");
    await expect(readFile(first.reportAbsolutePath, "utf8")).resolves.toContain("VERDICT: PASS");
    await expect(readFile(second.reportAbsolutePath, "utf8")).resolves.toContain("VERDICT: WARN");
  });

  it("keeps the patrol report command away from headless agent imports", async () => {
    const sources = await Promise.all(
      ["src/commands/patrol.ts", "src/core/overseer/patrol.ts"].map((file) =>
        readFile(join(process.cwd(), file), "utf8")
      )
    );

    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });
});

async function runPatrolCommand(root: string, input: string): Promise<{ stdout: string; stderr: string }> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  const output = createIO(input);
  registerPatrolCommand(program, output.io);
  process.chdir(root);
  await program.parseAsync(["node", "specmarten", "patrol", "report"], { from: "node" });
  return { stdout: output.stdout(), stderr: output.stderr() };
}

function createIO(input: string): {
  io: PatrolCommandIO;
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-patrol-report-test-"));
  await mkdir(join(root, "specmarten", "reports"), { recursive: true });
  await writeState(root, {
    ...createInitialState(),
    mission: "Patrol CLI"
  });
  return root;
}

function reportBody(verdict: "PASS" | "WARN" | "BLOCK"): string {
  return `# Overseer 巡检报告 · do-status
## 概要
Client session completed patrol.
## 发现
| # | 维度 | 严重度 | 位置(文件:符号) | 说明 | 建议 |
| 1 | 范围核对 | ${verdict} | src/cli.ts:status | Finding | Review |
## 回写建议
- 无

VERDICT: ${verdict}
`;
}
