import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNewStreamCommand } from "../src/commands/new-stream.js";
import { TOOL } from "../src/constants.js";
import { createNewStreamDraftState } from "../src/core/streams/new-stream.js";
import type { SpecMartenState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("new-stream", () => {
  it("creates a reviewed draft that supersedes the current stream by default", async () => {
    const root = await createProject(activeV1State());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, "new-stream", "Visualization");
    const state = await readState(root);

    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("plan");
    expect(state.currentVersion).toBe("v2");
    expect(state.streams[0]).toMatchObject({ id: "v1", version: "v1", state: "maintained" });
    expect(state.streams[1]).toMatchObject({
      id: "v2",
      version: "v2",
      label: "Visualization",
      state: "active",
      supersedes: "v1"
    });
    await expect(readFile(join(root, TOOL.dataDir, "dashboard.html"), "utf8")).resolves.toContain("Visualization");
    await expect(readFile(join(root, TOOL.dataDir, "plan-report.md"), "utf8")).resolves.toContain("supersedes v1");
    expect(log.mock.calls.flat().join("\n")).toContain("new stream draft");
  });

  it("supports explicit parallel streams without retiring the current stream", async () => {
    const root = await createProject(activeV1State());

    await runCommand(root, "new-stream", "Research", "--parallel");
    const state = await readState(root);

    expect(state.currentVersion).toBe("v2");
    expect(state.streams[0]).toMatchObject({ id: "v1", state: "active" });
    expect(state.streams[1]).toMatchObject({ id: "v2", label: "Research", state: "active" });
    expect(state.streams[1]?.supersedes).toBeUndefined();
  });

  it("accepts explicit stream version without conflicting with the root version flag", async () => {
    const root = await createProject(activeV1State());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.name("specmarten").version("0.0.0");
    registerNewStreamCommand(program);
    process.chdir(root);
    await program.parseAsync(
      ["node", "specmarten", "new-stream", "Release polish", "--id", "release", "--stream-version", "vNext"],
      { from: "node" }
    );
    const state = await readState(root);

    expect(state.streams[1]).toMatchObject({
      id: "release",
      version: "vNext",
      label: "Release polish"
    });
    expect(log.mock.calls.flat().join("\n")).toContain("vNext · Release polish");
  });

  it("preserves explicit id, version, and supersedes values", () => {
    const draft = createNewStreamDraftState(activeV1State(), {
      root: "/tmp/unused",
      label: "Visual dashboard",
      id: "viz",
      version: "v2",
      supersedes: "v1"
    });

    expect(draft.streams[1]).toMatchObject({
      id: "viz",
      version: "v2",
      label: "Visual dashboard",
      supersedes: "v1"
    });
  });

  it("rejects ambiguous relation options without modifying state", async () => {
    const root = await createProject(activeV1State());
    const before = await readState(root);

    await expect(runCommand(root, "new-stream", "Bad", "--parallel", "--supersedes", "v1")).rejects.toThrow(
      "Use either --parallel or --supersedes"
    );

    expect(await readState(root)).toEqual(before);
  });

  it("has no agent or shell runner dependency", async () => {
    const sources = await Promise.all(
      ["src/commands/new-stream.ts", "src/core/streams/new-stream.ts"].map((file) =>
        readFile(join(process.cwd(), file), "utf8")
      )
    );

    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });
});

async function runCommand(root: string, ...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerNewStreamCommand(program);
  process.chdir(root);
  await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
}

async function createProject(state: SpecMartenState): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-new-stream-test-"));
  await mkdir(join(root, TOOL.dataDir), { recursive: true });
  await writeState(root, state);
  return root;
}

function activeV1State(): SpecMartenState {
  return {
    ...createInitialState(),
    updatedAt: "2026-07-04T00:00:00.000Z",
    mission: "Test roadmap",
    currentVersion: "v1",
    streams: [
      {
        id: "v1",
        version: "v1",
        label: "Account access",
        state: "active",
        phases: [
          {
            id: "p1",
            title: "Account basics",
            status: "in-progress",
            tasks: [{ id: "p1.1", title: "Ship sign-in", status: "in-progress", changes: [] }]
          }
        ]
      }
    ]
  };
}
