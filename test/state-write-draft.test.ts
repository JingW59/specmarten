import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerStateCommand, type StateCommandIO } from "../src/commands/state.js";
import { TOOL } from "../src/constants.js";
import { buildPlanContext } from "../src/core/context/plan-context.js";
import { planOutputSchema } from "../src/core/planner/schema.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { parseBackfillDraftJson, parseMaintainDraftJson, parsePlanDraftJson } from "../src/core/state/write-draft.js";
import { createInitialState, readState, stateLockPath, writeInitialStateIfMissing, writeState } from "../src/core/state/store.js";
import { pathExists } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
});

describe("state write-draft", () => {
  it("writes state through an atomic JSON write behind a removable lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-state-store-test-"));
    await mkdir(join(root, TOOL.dataDir), { recursive: true });

    await writeState(root, createInitialState());

    expect(await pathExists(stateLockPath(root))).toBe(false);
    expect((await readdir(join(root, TOOL.dataDir))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    await expect(readState(root)).resolves.toMatchObject({ version: 2, streams: [] });
  });

  it("initializes state only once while using the state write lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-state-store-test-"));
    const first = await writeInitialStateIfMissing(root);
    const second = await writeInitialStateIfMissing(root);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await pathExists(stateLockPath(root))).toBe(false);
  });

  it("writes a valid plan draft from --file, then renders report and generated views", async () => {
    const root = await createSpecMartenProject();
    const draftFile = join(root, "plan-output.json");
    await writeFile(draftFile, JSON.stringify(validPlanOutput()), "utf8");

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "plan", "--file", draftFile]);
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wrote a plan draft");
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("plan");
    expect(state.mission).toBe("Client-first roadmap");
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      title: "Implement write-draft",
      changes: []
    });
    await expect(readFile(join(root, TOOL.dataDir, "plan-report.md"), "utf8")).resolves.toContain(
      "Which prompt should be installed?"
    );
    await expect(readFile(join(root, TOOL.dataDir, "roadmap.md"), "utf8")).resolves.toContain(
      "AI-GENERATED DRAFT"
    );
    await expect(readFile(join(root, TOOL.dataDir, "dashboard.html"), "utf8")).resolves.toContain(
      "Implement write-draft"
    );
  });

  it("reads a lenient plan draft from stdin and normalizes missing default fields", async () => {
    const root = await createSpecMartenProject();
    const input = JSON.stringify({
      phases: [
        {
          id: "p1",
          title: "MVP",
          tasks: [{ id: "p1.1", title: "Task without status", changes: [] }]
        }
      ]
    });

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "plan"], input);
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(state.mission).toBe("Existing mission");
    expect(collectPhases(state)).toEqual([
      {
        id: "p1",
        title: "MVP",
        status: "planned",
        tasks: [{ id: "p1.1", title: "Task without status", status: "todo", changes: [] }]
      }
    ]);
    await expect(readFile(join(root, TOOL.dataDir, "plan-report.md"), "utf8")).resolves.toContain(
      "Requirement: not provided"
    );
  });

  it("returns structured stderr for bad JSON and leaves state untouched", async () => {
    const root = await createSpecMartenProject();
    const originalState = await readState(root);

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "plan"], "{not json");
    const body = JSON.parse(result.stderr) as { error: string; kind: string; issues: Array<{ message: string }> };

    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(body.error).toBe("invalid_draft_json");
    expect(body.kind).toBe("plan");
    expect(body.issues[0]?.message).toContain("JSON");
    expect(await readState(root)).toEqual(originalState);
    expect(await pathExists(join(root, TOOL.dataDir, "roadmap.md"))).toBe(false);
  });

  it("returns structured stderr for schema errors and leaves state untouched", async () => {
    const root = await createSpecMartenProject();
    const originalState = await readState(root);
    const badDraftFile = join(root, "bad-plan-output.json");
    await writeFile(
      badDraftFile,
      JSON.stringify({
        phases: [{ id: "p1", status: "planned", tasks: [] }]
      }),
      "utf8"
    );

    const result = await runStateCommand(root, [
      "state",
      "write-draft",
      "--kind",
      "plan",
      "--file",
      badDraftFile
    ]);
    const body = JSON.parse(result.stderr) as {
      error: string;
      kind: string;
      issues: Array<{ path: Array<string | number>; message: string }>;
    };

    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(body.error).toBe("invalid_draft_schema");
    expect(body.kind).toBe("plan");
    expect(body.issues.some((issue) => issue.path.join(".") === "phases.0.title")).toBe(true);
    expect(await readState(root)).toEqual(originalState);
    expect(await pathExists(join(root, TOOL.dataDir, "roadmap.md"))).toBe(false);
  });

  it("keeps the context output schema closed with the write-draft parser", async () => {
    const root = await createSpecMartenProject();
    const context = await buildPlanContext({ root, requirement: "Build write-draft" });
    const outputSchema = context.outputSchema as {
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };
    const advertised = validPlanOutput();
    const streamAdvertised = validPlanStreamOutput();

    expect(context.outputSchema).toEqual(planOutputSchema());
    // Closed contract: no extra top-level keys, and every required key is a property.
    expect(outputSchema.additionalProperties).toBe(false);
    expect(outputSchema.required.every((key) => key in outputSchema.properties)).toBe(true);
    // The advertised schema documents the stream-aware fields.
    const schemaJson = JSON.stringify(outputSchema);
    expect(schemaJson).toContain("streams");
    expect(schemaJson).toContain("currentVersion");
    expect(schemaJson).toContain("tracks");
    expect(schemaJson).toContain("supersedes");
    // Both the legacy and stream-aware advertised shapes are accepted by the ingest parser.
    expect(parsePlanDraftJson(JSON.stringify(advertised))).toEqual(advertised);
    const parsedStream = parsePlanDraftJson(JSON.stringify(streamAdvertised));
    expect(parsedStream.currentVersion).toBe("v2");
    expect(parsedStream.streams).toEqual(streamAdvertised.streams);

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "plan"], JSON.stringify(advertised));
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(collectPhases(state)[0]?.title).toBe("Plan chain");
  });

  it("writes a stream-aware plan draft preserving multiple streams/tracks/currentVersion/supersedes", async () => {
    const root = await createSpecMartenProject();

    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "plan"],
      JSON.stringify(validPlanStreamOutput())
    );
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wrote a plan draft");
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("plan");
    expect(state.currentVersion).toBe("v2");
    expect(state.streams).toHaveLength(2);
    expect(state.streams[0]).toMatchObject({ id: "v1", version: "v1", state: "maintained" });
    expect(state.streams[1]).toMatchObject({ id: "v2", version: "v2", state: "active", supersedes: "v1" });
    // Tracks are preserved, not flattened away.
    expect(state.streams[1]?.tracks?.[0]?.phases[0]?.tasks[0]).toMatchObject({
      title: "Design API",
      status: "todo",
      changes: []
    });
    // collectPhases still flattens across the maintained stream and the active track.
    expect(collectPhases(state).map((phase) => phase.title)).toEqual(["Shipped", "New API"]);
  });

  it("writes a stream-aware backfill draft preserving streams/tracks and inferring status/archivedAt/unlinkedChanges", async () => {
    const root = await createBackfillProject();

    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "backfill"],
      JSON.stringify(validBackfillStreamOutput())
    );
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wrote a backfill draft");
    expect(state.draftKind).toBe("backfill");
    expect(state.currentVersion).toBe("v2");
    expect(state.streams).toHaveLength(2);
    expect(state.streams[0]).toMatchObject({ id: "v1", state: "maintained" });
    expect(state.streams[1]).toMatchObject({ id: "v2", state: "active", supersedes: "v1" });

    // Archived change linked in the maintained stream -> done with archivedAt.
    const loginTask = state.streams[0]?.phases?.[0]?.tasks[0];
    expect(loginTask).toMatchObject({
      title: "Login",
      status: "done",
      changes: ["2026-06-01-add-login"],
      archivedAt: "2026-06-01"
    });
    // Active change linked in the active stream track -> in-progress.
    const statusTask = state.streams[1]?.tracks?.[0]?.phases[0]?.tasks[0];
    expect(statusTask).toMatchObject({ title: "Add status command", status: "in-progress", changes: ["add-status-command"] });
    // The archived change that no task links becomes unlinked (and is not superseded).
    expect(state.unlinkedChanges).toContain("2026-05-01-old");
  });

  it("accepts stream and track title as backfill label aliases", async () => {
    const root = await createBackfillProject();
    const draft = JSON.parse(JSON.stringify(validBackfillStreamOutput())) as {
      streams: Array<{
        label?: string;
        title?: string;
        tracks?: Array<{ label?: string; title?: string }>;
      }>;
    };
    draft.streams[1].title = "Current Work";
    delete draft.streams[1].label;
    draft.streams[1].tracks![0].title = "Status Track";
    delete draft.streams[1].tracks![0].label;

    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "backfill"],
      JSON.stringify(draft)
    );
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(state.streams[1]?.label).toBe("Current Work");
    expect(state.streams[1]?.tracks?.[0]?.label).toBe("Status Track");
    expect(state.streams[1]?.label).not.toBe("Untitled stream");
    expect(state.streams[1]?.tracks?.[0]?.label).not.toBe("Untitled track");
  });

  it("writes a valid backfill draft from stdin, then renders report and generated views", async () => {
    const root = await createBackfillProject();

    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "backfill"],
      JSON.stringify(validBackfillOutput())
    );
    const state = await readState(root);

    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wrote a backfill draft");
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("backfill");
    expect(state.mission).toBe("Example product");
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
    await expect(readFile(join(root, TOOL.dataDir, "backfill-report.md"), "utf8")).resolves.toContain(
      "low confidence status mapping"
    );
    await expect(readFile(join(root, TOOL.dataDir, "roadmap.md"), "utf8")).resolves.toContain(
      "AUTO-BACKFILLED DRAFT"
    );
    await expect(readFile(join(root, TOOL.dataDir, "dashboard.html"), "utf8")).resolves.toContain(
      "Add status command"
    );
  });

  it("returns structured stderr for bad backfill JSON and leaves state untouched", async () => {
    const root = await createBackfillProject();

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "backfill"], "{not json");
    const body = JSON.parse(result.stderr) as { error: string; kind: string; issues: Array<{ message: string }> };

    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(body.error).toBe("invalid_draft_json");
    expect(body.kind).toBe("backfill");
    expect(body.issues[0]?.message).toContain("JSON");
    expect(await pathExists(join(root, TOOL.dataDir, "state.json"))).toBe(false);
    expect(await pathExists(join(root, TOOL.dataDir, "roadmap.md"))).toBe(false);
  });

  it("normalizes real LLM-shaped backfill draft diagnostics before writing state", async () => {
    const root = await createBackfillProject();
    const advertised = {
      mission: "Example product",
      phases: [
        {
          title: "Account MVP",
          tasks: [
            { title: "Login", changes: ["2026-06-01-add-login", "2026-05-01-old"] },
            { title: "Status", changes: ["add-status-command"] }
          ]
        }
      ],
      unlinkedChanges: [{ id: "stray-change" }],
      lowConfidence: [{ change: "add-status-command", reason: "ambiguous mapping" }],
      superseded: [{ change: "2026-05-01-old", reason: "replaced by add-login" }],
      notes: [{ note: "batch 1 done" }]
    };

    const parsed = parseBackfillDraftJson(JSON.stringify(advertised));
    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "backfill"],
      JSON.stringify(advertised)
    );
    const state = await readState(root);
    const tasks = collectPhases(state).flatMap((phase) => phase.tasks);

    expect(parsed.lowConfidence).toEqual(["add-status-command: ambiguous mapping"]);
    expect(parsed.superseded).toEqual(["2026-05-01-old"]);
    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(tasks.some((task) => task.changes.includes("2026-05-01-old"))).toBe(false);
    expect(state.unlinkedChanges).toContain("stray-change");
  });

  it("writes a maintain draft and normalizes real LLM-shaped state fields", async () => {
    const root = await createMaintainProject();
    const advertised = {
      state: {
        mission: "Maintained product",
        phases: [
          {
            title: "Account MVP",
            status: "in_progress",
            tasks: [
              { title: "Login", status: "completed", changes: ["2026-06-01-add-login"] },
              { title: "Status", status: "wip", changes: ["add-status-command"] },
              { title: "No explicit status", changes: [] }
            ]
          }
        ],
        unlinkedChanges: [{ id: "stray-change" }],
        lastPatrol: { change: "broken-echo", verdict: "WARN" }
      },
      notes: [{ note: "normalized note" }]
    };

    const parsed = parseMaintainDraftJson(JSON.stringify(advertised));
    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "maintain"],
      JSON.stringify(advertised)
    );
    const state = await readState(root);

    expect(parsed.notes).toEqual(["normalized note"]);
    expect(parsed.state?.unlinkedChanges).toEqual(["stray-change"]);
    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wrote maintained state");
    expect(state.draft).toBeUndefined();
    expect(state.mission).toBe("Maintained product");
    expect(state.lastPatrol?.change).toBe("do-status");
    expect(collectPhases(state)[0]).toMatchObject({
      id: "p1",
      title: "Account MVP",
      status: "in-progress"
    });
    expect(collectPhases(state)[0]?.tasks).toEqual([
      {
        id: "p1.1",
        title: "Login",
        status: "done",
        changes: ["2026-06-01-add-login"],
        archivedAt: "2026-06-01"
      },
      {
        id: "p1.2",
        title: "Status",
        status: "in-progress",
        changes: ["add-status-command"]
      },
      {
        id: "p1.3",
        title: "No explicit status",
        status: "todo",
        changes: []
      }
    ]);
    await expect(readFile(join(root, TOOL.dataDir, "roadmap.md"), "utf8")).resolves.toContain("Maintained product");
    await expect(readFile(join(root, TOOL.dataDir, "dashboard.html"), "utf8")).resolves.toContain("Status");
  });

  it("writes stream-aware maintain output without flattening streams", async () => {
    const root = await createMaintainProject();
    const advertised = {
      state: {
        mission: "Maintained streams",
        currentVersion: "v2",
        streams: [
          {
            id: "v1",
            version: "v1",
            label: "Account access",
            state: "maintained",
            phases: [{ title: "Shipped", status: "done", tasks: [{ title: "Login", status: "done", changes: ["2026-06-01-add-login"] }] }]
          },
          {
            id: "v2",
            version: "v2",
            label: "Status reporting",
            state: "active",
            supersedes: "v1",
            tracks: [
              {
                label: "Status page",
                phases: [
                  {
                    title: "Surface",
                    tasks: [{ title: "Status", status: "wip", changes: ["add-status-command"] }]
                  }
                ]
              }
            ]
          }
        ],
        unlinkedChanges: []
      },
      notes: []
    };

    const parsed = parseMaintainDraftJson(JSON.stringify(advertised));
    const result = await runStateCommand(
      root,
      ["state", "write-draft", "--kind", "maintain"],
      JSON.stringify(advertised)
    );
    const state = await readState(root);

    expect(parsed.state?.streams?.[1]?.supersedes).toBe("v1");
    expect(process.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(state.draft).toBeUndefined();
    expect(state.currentVersion).toBe("v2");
    expect(state.streams).toHaveLength(2);
    expect(state.streams[0]).toMatchObject({ id: "v1", state: "maintained" });
    expect(state.streams[1]).toMatchObject({ id: "v2", state: "active", supersedes: "v1" });
    expect(state.streams[1]?.tracks?.[0]).toMatchObject({ id: "v2-track-1", label: "Status page" });
    expect(state.streams[1]?.tracks?.[0]?.phases[0]?.tasks[0]).toMatchObject({
      title: "Status",
      status: "in-progress",
      changes: ["add-status-command"]
    });
    await expect(readFile(join(root, TOOL.dataDir, "dashboard.html"), "utf8")).resolves.toContain("Status reporting");
  });

  it("returns structured stderr for bad maintain JSON and leaves state untouched", async () => {
    const root = await createMaintainProject();
    const originalState = await readState(root);

    const result = await runStateCommand(root, ["state", "write-draft", "--kind", "maintain"], "{not json");
    const body = JSON.parse(result.stderr) as { error: string; kind: string; issues: Array<{ message: string }> };

    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(body.error).toBe("invalid_draft_json");
    expect(body.kind).toBe("maintain");
    expect(body.issues[0]?.message).toContain("JSON");
    expect(await readState(root)).toEqual(originalState);
    expect(await pathExists(join(root, TOOL.dataDir, "roadmap.md"))).toBe(false);
  });

  it("does not import or call AI runner code from the write-draft path", async () => {
    const files = [
      "src/commands/state.ts",
      "src/core/state/write-draft.ts",
      "src/core/planner/draft.ts",
      "src/core/backfill/draft.ts",
      "src/core/backfill/snapshot.ts",
      "src/core/maintenance/draft.ts",
      "src/core/maintenance/reconcile.ts"
    ];
    const sources = await Promise.all(files.map((file) => readFile(join(process.cwd(), file), "utf8")));

    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });
});

async function runStateCommand(
  root: string,
  args: string[],
  input = ""
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

async function createSpecMartenProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-write-draft-test-"));
  await mkdir(join(root, TOOL.dataDir), { recursive: true });
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Existing mission",
  }, [
      {
        id: "old",
        title: "Old phase",
        status: "planned",
        tasks: [{ id: "old.1", title: "Keep me until valid draft", status: "todo", changes: [] }]
      }
    ]));
  return root;
}

function validPlanOutput() {
  return {
    mission: "Client-first roadmap",
    phases: [
      {
        id: "p1",
        title: "Plan chain",
        status: "planned",
        tasks: [
          {
            id: "p1.1",
            title: "Implement write-draft",
            status: "todo",
            changes: []
          }
        ]
      }
    ],
    questions: ["Which prompt should be installed?"],
    notes: ["Draft only"]
  };
}

function validBackfillOutput() {
  return {
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
    lowConfidence: ["low confidence status mapping"],
    superseded: [],
    notes: ["sample"]
  };
}

function validPlanStreamOutput() {
  return {
    mission: "Stream-aware plan",
    currentVersion: "v2",
    streams: [
      {
        id: "v1",
        version: "v1",
        label: "v1",
        state: "maintained",
        phases: [{ id: "v1-p1", title: "Shipped", status: "done", tasks: [] }]
      },
      {
        id: "v2",
        version: "v2",
        label: "v2",
        state: "active",
        supersedes: "v1",
        tracks: [
          {
            id: "v2-api",
            label: "API",
            phases: [
              {
                id: "v2-api-p1",
                title: "New API",
                status: "planned",
                tasks: [{ id: "v2-api-p1.1", title: "Design API", status: "todo", changes: [] }]
              }
            ]
          }
        ]
      }
    ],
    questions: ["which track first?"],
    notes: ["stream plan"]
  };
}

function validBackfillStreamOutput() {
  return {
    mission: "Stream backfill",
    currentVersion: "v2",
    streams: [
      {
        id: "v1",
        version: "v1",
        label: "v1",
        state: "maintained",
        phases: [
          {
            title: "Account",
            tasks: [{ title: "Login", changes: ["2026-06-01-add-login"] }]
          }
        ]
      },
      {
        id: "v2",
        version: "v2",
        label: "v2",
        state: "active",
        supersedes: "v1",
        tracks: [
          {
            label: "Status",
            phases: [
              {
                title: "Status work",
                tasks: [{ title: "Add status command", changes: ["add-status-command"] }]
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
  };
}

async function createBackfillProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-write-backfill-test-"));
  await mkdir(join(root, TOOL.dataDir), { recursive: true });
  await mkdir(join(root, "openspec", "specs", "account"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive", "2026-06-01-add-login", "specs", "account"), {
    recursive: true
  });
  await mkdir(join(root, "openspec", "changes", "archive", "2026-05-01-old", "specs", "account"), {
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
    join(root, "openspec", "changes", "archive", "2026-05-01-old", "proposal.md"),
    "# Old login approach\n\nSuperseded.\n",
    "utf8"
  );
  await writeFile(
    join(root, "openspec", "changes", "archive", "2026-05-01-old", "specs", "account", "spec.md"),
    "## ADDED Requirements\n### Requirement: Old login\n",
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
  return root;
}

async function createMaintainProject(): Promise<string> {
  const root = await createBackfillProject();
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Before maintain",
  }, [
      {
        id: "p1",
        title: "Before",
        status: "in-progress",
        tasks: [
          { id: "p1.1", title: "Login", status: "in-progress", changes: ["2026-06-01-add-login"] },
          { id: "p1.2", title: "Status", status: "todo", changes: ["add-status-command"] }
        ]
      }
    ], { currentVersion: "v1" }));
  const state = await readState(root);
  await writeState(root, {
    ...state,
    lastPatrol: {
      change: "do-status",
      verdict: "WARN",
      report: "reports/warn.md",
      at: "2026-06-21T00:00:00.000Z"
    }
  });
  return root;
}
