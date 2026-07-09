import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { runBackfill } from "../src/core/backfill/backfill.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { pathExists, readJson } from "../src/util/fs.js";

describe("backfill", () => {
  it("writes a draft state, roadmap, and report from archived and active OpenSpec changes", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);
    const backend = new OpenSpecBackend(root);

    const summary = await runBackfill({ root, backend, agent: new FakeBackfillAgent() });

    expect(summary.promoted).toBe(false);
    expect(summary.changesRead).toBe(2);
    expect(summary.phases).toBe(1);
    expect(summary.tasks).toBe(2);

    const state = await readState(root);
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("backfill");
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      title: "Add login flow",
      status: "done",
      changes: ["2026-06-01-add-login"],
      archivedAt: "2026-06-01"
    });
    expect(collectPhases(state)[0]?.tasks[1]).toMatchObject({
      title: "Add status command",
      status: "in-progress",
      changes: ["add-status-command"]
    });

    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain(
      "AUTO-BACKFILLED DRAFT"
    );
    await expect(readFile(join(root, "specmarten", "backfill-report.md"), "utf8")).resolves.toContain(
      "2026-06-01-add-login"
    );
    expect(await pathExists(join(root, "specmarten", "dashboard.html"))).toBe(true);
  });

  it("promotes the reviewed draft only when requested", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);
    const backend = new OpenSpecBackend(root);
    await runBackfill({ root, backend, agent: new FakeBackfillAgent() });

    const promoted = await runBackfill({ root, backend, promote: true });
    const state = await readState(root);

    expect(promoted.promoted).toBe(true);
    expect(state.draft).toBeUndefined();
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.not.toContain(
      "AUTO-BACKFILLED DRAFT"
    );
  });

  it("preserves an existing formal state and writes a separate draft proposal", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);
    await mkdir(join(root, "specmarten"), { recursive: true });
    await writeState(root, singleStreamState({
      ...createInitialState(),
      mission: "Human confirmed",
    }, [
        {
          id: "p1",
          title: "Confirmed",
          status: "planned",
          tasks: [{ id: "p1.1", title: "Keep me", status: "todo", changes: [] }]
        }
      ]));

    const summary = await runBackfill({
      root,
      backend: new OpenSpecBackend(root),
      agent: new FakeBackfillAgent()
    });
    const state = await readState(root);
    const draft = await readJson(join(root, "specmarten", "backfill-state.draft.json"));

    expect(summary.preservedFormalState).toBe(true);
    expect(state.mission).toBe("Human confirmed");
    expect(JSON.stringify(draft)).toContain("Add login flow");
  });

  it("fails closed when no agent runner is available", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);

    await expect(runBackfill({ root, backend: new OpenSpecBackend(root) })).rejects.toThrow(
      "Backfill requires an available"
    );
    expect(await pathExists(join(root, "specmarten", "state.json"))).toBe(false);
  });

  it("passes group-by to the AI prompt", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);
    const agent = new FakeBackfillAgent();

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent, groupBy: "time" });

    expect(agent.prompts[0]).toContain("Group phases by: time");
  });

  it("filters superseded changes from state but keeps them in the report", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new SupersededBackfillAgent() });
    const state = await readState(root);
    const report = await readFile(join(root, "specmarten", "backfill-report.md"), "utf8");

    expect(JSON.stringify(state)).not.toContain("2026-06-01-add-login");
    expect(report).toContain("2026-06-01-add-login");
  });

  it("caches AI backfill output so reruns do not recompute unchanged projects", async () => {
    const root = await tempRoot();
    await createBrownfieldOpenSpec(root);
    const agent = new CountingBackfillAgent();

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent });
    await runBackfill({ root, backend: new OpenSpecBackend(root), agent });

    expect(agent.calls).toBe(1);
  });

  it("batches large backfills and caches each unchanged batch", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);
    const agent = new BatchBackfillAgent();

    const first = await runBackfill({ root, backend: new OpenSpecBackend(root), agent });
    const second = await runBackfill({ root, backend: new OpenSpecBackend(root), agent });
    const state = await readState(root);

    expect(first.batches).toBe(3);
    expect(second.batches).toBe(3);
    expect(agent.calls).toBe(3);
    expect(collectPhases(state).length).toBe(3);
  });

  it("merges repeated direct stream phases without flattening stream-aware batches", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new DirectStreamBatchBackfillAgent() });
    const state = await readState(root);

    expect(state.currentVersion).toBe("v2");
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0]).toMatchObject({
      id: "v2",
      version: "v2",
      label: "Launch v2",
      supersedes: "v1"
    });
    expect(state.streams[0]?.phases).toHaveLength(1);
    expect(state.streams[0]?.phases?.[0]?.title).toBe("Shared Build");
    expect(state.streams[0]?.phases?.[0]?.tasks).toHaveLength(81);
    expect(state.streams[0]?.phases?.[0]?.tasks[0]?.changes).toEqual(["2026-06-01-change-1"]);
    expect(state.streams[0]?.phases?.[0]?.tasks.at(-1)?.changes).toEqual(["2026-06-81-change-81"]);
  });

  it("keeps streams with different ids separate even when labels match", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new SameLabelDistinctStreamAgent() });
    const state = await readState(root);

    expect(state.streams.map((stream) => stream.id)).toEqual(["v2-a", "v2-b", "v2-c"]);
    expect(state.streams.map((stream) => stream.label)).toEqual(["Launch v2", "Launch v2", "Launch v2"]);
    expect(state.streams.map((stream) => stream.phases?.[0]?.title)).toEqual([
      "Shared Build",
      "Shared Build",
      "Shared Build"
    ]);
    expect(state.streams.map((stream) => stream.phases?.[0]?.tasks.length)).toEqual([40, 40, 1]);
  });

  it("merges repeated track phases inside the same stream and track", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new TrackBatchBackfillAgent() });
    const state = await readState(root);

    expect(state.currentVersion).toBe("v2");
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0]?.tracks).toHaveLength(1);
    expect(state.streams[0]?.tracks?.[0]).toMatchObject({ id: "frontend", label: "Frontend" });
    expect(state.streams[0]?.tracks?.[0]?.phases).toHaveLength(1);
    expect(state.streams[0]?.tracks?.[0]?.phases[0]?.title).toBe("Track Shared");
    expect(state.streams[0]?.tracks?.[0]?.phases[0]?.tasks).toHaveLength(81);
    expect(state.streams[0]?.tracks?.[0]?.phases[0]?.tasks[0]?.changes).toEqual(["2026-06-01-change-1"]);
    expect(state.streams[0]?.tracks?.[0]?.phases[0]?.tasks.at(-1)?.changes).toEqual([
      "2026-06-81-change-81"
    ]);
  });

  it("keeps tracks with different ids separate even when labels match", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new SameLabelDistinctTrackAgent() });
    const state = await readState(root);
    const tracks = state.streams[0]?.tracks ?? [];

    expect(state.streams).toHaveLength(1);
    expect(tracks.map((track) => track.id)).toEqual(["frontend-a", "frontend-b", "frontend-c"]);
    expect(tracks.map((track) => track.label)).toEqual(["Frontend", "Frontend", "Frontend"]);
    expect(tracks.map((track) => track.phases[0]?.title)).toEqual([
      "Track Shared",
      "Track Shared",
      "Track Shared"
    ]);
    expect(tracks.map((track) => track.phases[0]?.tasks.length)).toEqual([40, 40, 1]);
  });

  it("keeps legacy batched phases supported and consolidated by title", async () => {
    const root = await tempRoot();
    await createLargeOpenSpec(root, 81);

    await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new LegacyConsolidatingBatchAgent() });
    const state = await readState(root);

    expect(state.currentVersion).toBe("v1");
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0]?.phases).toHaveLength(1);
    expect(state.streams[0]?.phases?.[0]?.title).toBe("Legacy Shared");
    expect(state.streams[0]?.phases?.[0]?.tasks).toHaveLength(81);
    expect(state.streams[0]?.phases?.[0]?.tasks[0]?.changes).toEqual(["2026-06-01-change-1"]);
    expect(state.streams[0]?.phases?.[0]?.tasks.at(-1)?.changes).toEqual(["2026-06-81-change-81"]);
  });
});

class FakeBackfillAgent implements AgentRunner {
  name = "codex" as const;
  prompts: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return JSON.stringify({
      mission: "Example product",
      phases: [
        {
          title: "Account MVP",
          tasks: [
            { title: "Add login flow", changes: ["2026-06-01-add-login"] },
            { title: "Add status command", changes: ["add-status-command"] }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: ["sample"]
    });
  }
}

class SupersededBackfillAgent extends FakeBackfillAgent {
  override async run(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return JSON.stringify({
      mission: "Example product",
      phases: [
        {
          title: "Account MVP",
          tasks: [
            { title: "Add login flow", changes: ["2026-06-01-add-login"] },
            { title: "Add status command", changes: ["add-status-command"] }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: ["2026-06-01-add-login"],
      notes: ["older login change superseded"]
    });
  }
}

class CountingBackfillAgent extends FakeBackfillAgent {
  calls = 0;

  override async run(prompt: string): Promise<string> {
    this.calls += 1;
    return super.run(prompt);
  }
}

class BatchBackfillAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    return JSON.stringify({
      mission: "Large project",
      phases: [
        {
          title: `Batch ${this.calls}`,
          tasks: changes.map((change) => ({ title: change.title ?? change.id, changes: [change.id] }))
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class DirectStreamBatchBackfillAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    const titles = ["Shared Build", " shared build ", "SHARED BUILD"];
    return JSON.stringify({
      mission: "Large stream project",
      currentVersion: "v2",
      streams: [
        {
          id: "v2",
          version: "v2",
          label: "Launch v2",
          state: "active",
          supersedes: "v1",
          phases: [
            {
              title: titles[this.calls - 1] ?? "Shared Build",
              tasks: changes.map((change) => ({
                title: change.title ?? change.id,
                changes: [change.id]
              }))
            }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class SameLabelDistinctStreamAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    const streamIds = ["v2-a", "v2-b", "v2-c"];
    return JSON.stringify({
      mission: "Large stream project",
      currentVersion: "v2-a",
      streams: [
        {
          id: streamIds[this.calls - 1] ?? `v2-${this.calls}`,
          version: streamIds[this.calls - 1] ?? `v2-${this.calls}`,
          label: "Launch v2",
          state: "active",
          phases: [
            {
              title: "Shared Build",
              tasks: changes.map((change) => ({
                title: change.title ?? change.id,
                changes: [change.id]
              }))
            }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class TrackBatchBackfillAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    const titles = ["Track Shared", " track shared ", "TRACK SHARED"];
    return JSON.stringify({
      mission: "Large tracked project",
      currentVersion: "v2",
      streams: [
        {
          id: "v2",
          version: "v2",
          label: "Launch v2",
          state: "active",
          tracks: [
            {
              id: "frontend",
              label: "Frontend",
              phases: [
                {
                  title: titles[this.calls - 1] ?? "Track Shared",
                  tasks: changes.map((change) => ({
                    title: change.title ?? change.id,
                    changes: [change.id]
                  }))
                }
              ]
            }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class SameLabelDistinctTrackAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    const trackIds = ["frontend-a", "frontend-b", "frontend-c"];
    return JSON.stringify({
      mission: "Large tracked project",
      currentVersion: "v2",
      streams: [
        {
          id: "v2",
          version: "v2",
          label: "Launch v2",
          state: "active",
          tracks: [
            {
              id: trackIds[this.calls - 1] ?? `frontend-${this.calls}`,
              label: "Frontend",
              phases: [
                {
                  title: "Track Shared",
                  tasks: changes.map((change) => ({
                    title: change.title ?? change.id,
                    changes: [change.id]
                  }))
                }
              ]
            }
          ]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

class LegacyConsolidatingBatchAgent implements AgentRunner {
  name = "codex" as const;
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.calls += 1;
    const changes = extractPromptChanges(prompt);
    const titles = ["Legacy Shared", " legacy shared ", "LEGACY SHARED"];
    return JSON.stringify({
      mission: "Large legacy project",
      phases: [
        {
          title: titles[this.calls - 1] ?? "Legacy Shared",
          tasks: changes.map((change) => ({
            title: change.title ?? change.id,
            changes: [change.id]
          }))
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-backfill-test-"));
}

async function createBrownfieldOpenSpec(root: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "account"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive", "2026-06-01-add-login", "specs", "account"), {
    recursive: true
  });
  await mkdir(join(root, "openspec", "changes", "add-status-command", "specs", "account"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "account", "spec.md"), "# Account Spec\n", "utf8");
  await writeFile(
    join(root, "openspec", "changes", "archive", "2026-06-01-add-login", "proposal.md"),
    "# Add login flow\n\nUsers can sign in.\n",
    "utf8"
  );
  await writeFile(
    join(root, "openspec", "changes", "archive", "2026-06-01-add-login", "specs", "account", "spec.md"),
    "## ADDED Requirements\n### Requirement: Login\n",
    "utf8"
  );
  await writeFile(
    join(root, "openspec", "changes", "add-status-command", "proposal.md"),
    "# Add status command\n\nExpose current status.\n",
    "utf8"
  );
  await writeFile(
    join(root, "openspec", "changes", "add-status-command", "specs", "account", "spec.md"),
    "## ADDED Requirements\n### Requirement: Status command\n",
    "utf8"
  );
}

async function createLargeOpenSpec(root: string, count: number): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "large"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "large", "spec.md"), "# Large Spec\n", "utf8");

  for (let index = 1; index <= count; index += 1) {
    const id = `2026-06-${String(index).padStart(2, "0")}-change-${index}`;
    await mkdir(join(root, "openspec", "changes", "archive", id, "specs", "large"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "archive", id, "proposal.md"), `# Change ${index}\n`, "utf8");
    await writeFile(
      join(root, "openspec", "changes", "archive", id, "specs", "large", "spec.md"),
      `## ADDED Requirements\n### Requirement: Change ${index}\n`,
      "utf8"
    );
  }
}

function extractPromptChanges(prompt: string): Array<{ id: string; title?: string }> {
  const marker = "Changes:\n";
  const start = prompt.indexOf(marker);
  if (start === -1) {
    return [];
  }

  return JSON.parse(prompt.slice(start + marker.length)) as Array<{ id: string; title?: string }>;
}
