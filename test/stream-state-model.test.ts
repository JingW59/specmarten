import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerStateCommand, type StateCommandIO } from "../src/commands/state.js";
import type { SpecBackend } from "../src/adapters/spec-backend/types.js";
import { defaultConfig } from "../src/config/config.js";
import { TOOL } from "../src/constants.js";
import { renderDashboardHtml } from "../src/core/renderers/dashboard.js";
import { renderRoadmapMarkdown } from "../src/core/renderers/roadmap.js";
import { formatStatus, runStatus } from "../src/core/status/status.js";
import { collectPhases, stateSchema } from "../src/core/state/schema.js";
import { migrateState, readState, statePath, writeState } from "../src/core/state/store.js";
import { pathExists, readJson } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

describe("stream state model", () => {
  it("migrates v1 state to a single active v2 stream losslessly and idempotently", async () => {
    const root = await tempRoot();
    const legacy = legacyState();
    await writeLegacyState(root, legacy);

    const migrated = await readState(root);
    const phases = collectPhases(migrated);

    expect(migrated.version).toBe(2);
    expect(migrated).not.toHaveProperty("phases");
    expect(migrated.currentVersion).toBe("v1");
    expect(migrated.streams).toHaveLength(1);
    expect(migrated.streams[0]).toMatchObject({
      id: "v1",
      version: "v1",
      label: "v1",
      state: "active"
    });
    expect(phases).toEqual(legacy.phases);
    expect(phases[0]?.tasks[0]).toEqual(legacy.phases[0]?.tasks[0]);
    expect(migrateState(migrated)).toEqual(migrated);

    await writeState(root, migrated);
    await expect(readState(root)).resolves.toEqual(migrated);
  });

  it("normalizes v2 stream state leniently", () => {
    const parsed = stateSchema.parse({
      version: 2,
      updatedAt: "2026-06-29T00:00:00.000Z",
      mission: "Stream roadmap",
      currentVersion: "v2",
      streams: [
        {
          id: "v2",
          version: "v2",
          label: "Version 2",
          state: "active",
          phases: [
            {
              id: "p1",
              title: "Foundation",
              status: { value: "in_progress" },
              tasks: [
                {
                  id: "p1.1",
                  title: "Normalize statuses",
                  status: { status: "completed" }
                }
              ]
            }
          ]
        },
        {
          id: "v3",
          version: "v3",
          label: "Version 3",
          state: "planned"
        }
      ]
    });

    expect(collectPhases(parsed)[0]).toMatchObject({
      status: "in-progress",
      tasks: [{ status: "done", changes: [] }]
    });
    expect(parsed.streams[1]).toMatchObject({ phases: [] });
    expect(stateSchema.parse(parsed)).toEqual(parsed);
  });

  it("preserves render and status output for a migrated single-stream state", async () => {
    const root = await tempRoot();
    const legacy = legacyState();
    await writeLegacyState(root, legacy);

    const migrated = await readState(root);
    const roadmap = renderRoadmapMarkdown(migrated);
    const dashboard = renderDashboardHtml(migrated);
    const status = formatStatus(
      await runStatus({
        root,
        backend: new StableBackend(),
        config: defaultConfig()
      })
    );

    expect(collectPhases(migrated)).toEqual(legacy.phases);
    expect(roadmap).toContain("## v1 · v1");
    expect(roadmap).toContain("### Foundation");
    expect(roadmap).toContain("- [~] Build stream model (`stream-state-model`)");
    expect(dashboard).toContain("Build stream model");
    expect(status).toContain("Current phase: Foundation");
    expect(status).toContain("Progress: 1/2 (50%)");
    expect(status).toContain("In-progress changes: stream-state-model");
  });

  it("renders roadmap streams, supersedes links, tracks, and nested phases", () => {
    const state = stateSchema.parse({
      version: 2,
      updatedAt: "2026-06-29T00:00:00.000Z",
      mission: "Stream roadmap",
      currentVersion: "v2",
      streams: [
        {
          id: "account",
          version: "v1",
          label: "Account access",
          state: "maintained",
          phases: [
            {
              id: "account-p1",
              title: "Account basics",
              status: "done",
              tasks: [{ id: "account-1", title: "Create sign-in flow", status: "done" }]
            }
          ]
        },
        {
          id: "status",
          version: "v2",
          label: "Status reporting",
          state: "active",
          supersedes: "account",
          tracks: [
            {
              id: "account-lane",
              label: "Account lane",
              phases: [
                {
                  id: "status-p1",
                  title: "Status shell",
                  status: "in-progress",
                  tasks: [{ id: "status-1", title: "Publish account status", status: "in-progress" }]
                }
              ]
            }
          ]
        }
      ]
    });

    const roadmap = renderRoadmapMarkdown(state);

    expect(roadmap).toContain("## v1 · Account access");
    expect(roadmap).toContain("State: maintained");
    expect(roadmap).toContain("### Account basics");
    expect(roadmap).toContain("## v2 · Status reporting");
    expect(roadmap).toContain("State: active");
    expect(roadmap).toContain("Supersedes: account");
    expect(roadmap).toContain("### Account lane");
    expect(roadmap).toContain("#### Status shell");
    expect(roadmap).toContain("- [~] Publish account status");
  });

  it("accepts v2 state through write-draft and rejects irrecoverable v2 input without writing state", async () => {
    const acceptedRoot = await tempRoot();
    const validState = {
      version: 2,
      updatedAt: "2026-06-29T00:00:00.000Z",
      mission: "Accepted stream",
      currentVersion: "v2",
      streams: [
        {
          id: "v2",
          version: "v2",
          label: "Version 2",
          state: "active",
          phases: [
            {
              id: "p1",
              title: "Accepted",
              status: "in_progress",
              tasks: [{ id: "p1.1", title: "Write v2", status: { value: "done" } }]
            }
          ]
        }
      ],
      unlinkedChanges: []
    };

    const accepted = await runStateCommand(
      acceptedRoot,
      ["state", "write-draft", "--kind", "plan"],
      JSON.stringify(validState)
    );
    const persisted = await readJson<Record<string, unknown>>(join(acceptedRoot, TOOL.dataDir, "state.json"));
    const state = await readState(acceptedRoot);

    expect(process.exitCode).toBeUndefined();
    expect(accepted.stderr).toBe("");
    expect(persisted.version).toBe(2);
    expect(persisted).not.toHaveProperty("phases");
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("plan");
    expect(collectPhases(state)[0]?.tasks[0]?.status).toBe("done");

    const rejectedRoot = await tempRoot();
    const rejected = await runStateCommand(
      rejectedRoot,
      ["state", "write-draft", "--kind", "plan"],
      JSON.stringify({
        version: 2,
        updatedAt: "2026-06-29T00:00:00.000Z",
        mission: "Bad stream",
        currentVersion: "v2",
        streams: [{ version: "v2", label: "Missing id", state: "active" }],
        unlinkedChanges: []
      })
    );
    const body = JSON.parse(rejected.stderr) as { error: string; issues: Array<{ path: Array<string | number> }> };

    expect(process.exitCode).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(body.error).toBe("invalid_draft_schema");
    expect(body.issues.some((issue) => issue.path.join(".") === "streams.0.id")).toBe(true);
    expect(await pathExists(statePath(rejectedRoot))).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-stream-state-test-"));
  await mkdir(join(root, TOOL.dataDir), { recursive: true });
  return root;
}

async function writeLegacyState(root: string, state: ReturnType<typeof legacyState>): Promise<void> {
  await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function legacyState() {
  return {
    version: 1,
    updatedAt: "2026-06-29T00:00:00.000Z",
    mission: "Stream migration",
    phases: [
      {
        id: "p1",
        title: "Foundation",
        status: "in-progress",
        tasks: [
          {
            id: "p1.1",
            title: "Build stream model",
            status: "in-progress",
            changes: ["stream-state-model"]
          },
          {
            id: "p1.2",
            title: "Keep existing behavior",
            status: "done",
            changes: ["preserve-behavior"]
          }
        ]
      }
    ],
    lastPatrol: null,
    baseline: null,
    unlinkedChanges: []
  };
}

async function runStateCommand(
  root: string,
  args: string[],
  input: string
): Promise<{ stdout: string; stderr: string }> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  const output = createIO(input);
  registerStateCommand(program, output.io);
  process.chdir(root);
  await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
  return { stdout: output.stdout(), stderr: output.stderr() };
}

function createIO(input: string): {
  io: StateCommandIO;
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

class StableBackend implements SpecBackend {
  async isPresent() {
    return true;
  }

  async listActiveChanges() {
    return [];
  }

  async listArchivedChanges() {
    return [];
  }

  async readChange() {
    return {
      id: "unused",
      status: "active" as const,
      specsTouched: [],
      specDeltas: []
    };
  }

  async listSpecs() {
    return [];
  }

  async getCurrentMarker() {
    return "stable";
  }

  async getSpecsHash() {
    return "sha256:stable";
  }

  async snapshotSpecs() {
    return { specsHash: "sha256:stable", copiedFiles: 0 };
  }

  async hasChangedSince() {
    return false;
  }
}
