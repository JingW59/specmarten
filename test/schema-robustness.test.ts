import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig } from "../src/config/config.js";
import { runBackfill } from "../src/core/backfill/backfill.js";
import { backfillAgentResponseSchema, backfillOutputSchema } from "../src/core/backfill/schema.js";
import { runCheck } from "../src/core/check/check.js";
import { maintainAgentResponseSchema, maintainOutputSchema, normalizeAgentPhases } from "../src/core/maintenance/schema.js";
import { planAgentResponseSchema, planOutputSchema } from "../src/core/planner/schema.js";
import { collectPhases } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { writeJson } from "../src/util/fs.js";

// These fixtures reproduce the SHAPES real codex / GLM returned in the field that
// crashed the strict zod schemas (objects where strings were expected; an
// incomplete lastPatrol). They must pass without throwing.

describe("real-LLM output robustness", () => {
  it("backfill survives object-shaped lowConfidence/superseded/unlinkedChanges", async () => {
    const root = await openspecRepo();
    const summary = await runBackfill({ root, backend: new OpenSpecBackend(root), agent: new ObjectBackfillAgent() });
    const state = await readState(root);
    const tasks = collectPhases(state).flatMap((phase) => phase.tasks);

    expect(state.draft).toBe(true);
    // archived change linked + done; active change in-progress
    expect(tasks.find((task) => task.changes.includes("2026-06-01-add-login"))?.status).toBe("done");
    expect(tasks.find((task) => task.changes.includes("add-status-command"))?.status).toBe("in-progress");
    // superseded change (returned as an object) excluded from links
    expect(tasks.some((task) => task.changes.includes("2026-05-01-old"))).toBe(false);
    // diagnostic arrays normalized to plain strings
    expect(summary.lowConfidence.every((item) => typeof item === "string")).toBe(true);
    expect(summary.superseded).toContain("2026-05-01-old");
  });

  it("check still produces a verdict when the agent state carries an incomplete lastPatrol", async () => {
    const root = await openspecRepo();
    await writeState(root, createInitialState());

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      agent: new IncompleteLastPatrolAgent(),
      change: "add-status-command"
    });
    const state = await readState(root);

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.exitCode).toBe(2);
    expect(state.lastPatrol?.report).toMatch(/^reports\//);
    await expect(readFile(join(root, "specmarten", state.lastPatrol!.report), "utf8")).resolves.toContain("VERDICT: BLOCK");
  });

  it("normalizes status synonyms (in_progress / completed / wip / unknown)", () => {
    const parsed = maintainAgentResponseSchema.parse({
      state: {
        mission: "m",
        phases: [
          {
            title: "P",
            status: "in_progress",
            tasks: [
              { title: "T1", status: "completed", changes: [] },
              { title: "T2", status: "wip", changes: [] },
              { title: "T3", status: "weird-value", changes: [] }
            ]
          }
        ]
      },
      notes: []
    });
    const phases = normalizeAgentPhases(parsed.state!.phases);

    expect(phases[0]!.status).toBe("in-progress");
    expect(phases[0]!.tasks[0]!.status).toBe("done");
    expect(phases[0]!.tasks[1]!.status).toBe("in-progress");
    expect(phases[0]!.tasks[2]!.status).toBe("todo");
  });

  it("check degrades to WARN (not crash) when the agent returns malformed JSON", async () => {
    const root = await openspecRepo();
    await writeState(root, createInitialState());

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      agent: new MalformedJsonAgent(),
      change: "add-status-command"
    });
    const state = await readState(root);

    expect(summary.verdict).toBe("WARN");
    expect(summary.exitCode).toBe(10);
    expect(state.lastPatrol?.report).toMatch(/^reports\//);
  });

  it("keeps advertised draft output schemas accepted by ingest schemas", () => {
    const planSample = {
      mission: "Status CLI",
      phases: [
        {
          id: "p1",
          title: "MVP",
          status: "planned",
          tasks: [{ id: "p1.1", title: "Build status", status: "todo", changes: [] }]
        }
      ],
      questions: [],
      notes: []
    };
    const planStreamSample = {
      mission: "Status CLI v2",
      currentVersion: "v2",
      streams: [
        { id: "v1", version: "v1", label: "v1", state: "maintained", phases: [] },
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
                  title: "Build",
                  status: "planned",
                  tasks: [{ id: "v2-api-p1.1", title: "Design", status: "todo", changes: [] }]
                }
              ]
            }
          ]
        }
      ],
      questions: [],
      notes: []
    };
    const backfillSample = {
      mission: "Recovered roadmap",
      phases: [{ title: "MVP", tasks: [{ title: "Add status", changes: ["add-status-command"] }] }],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    };
    const backfillStreamSample = {
      mission: "Recovered streams",
      currentVersion: "v1",
      streams: [
        {
          id: "v1",
          version: "v1",
          label: "v1",
          state: "active",
          phases: [{ title: "MVP", tasks: [{ title: "Add status", changes: ["add-status-command"] }] }]
        }
      ],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    };
    const maintainSample = {
      state: {
        mission: "Maintained roadmap",
        phases: [{ title: "MVP", tasks: [{ title: "Add status", changes: ["add-status-command"] }] }],
        unlinkedChanges: []
      },
      patrol: {
        change: "add-status-command",
        report: "VERDICT: PASS"
      },
      notes: []
    };
    const maintainStreamSample = {
      state: {
        mission: "Maintained streams",
        currentVersion: "v2",
        streams: [
          { id: "v1", version: "v1", label: "v1", state: "maintained", phases: [] },
          {
            id: "v2",
            version: "v2",
            label: "v2",
            state: "active",
            supersedes: "v1",
            tracks: [{ id: "v2-ui", label: "UI", phases: [{ title: "Build", tasks: [] }] }]
          }
        ],
        unlinkedChanges: []
      },
      notes: []
    };

    expectTopLevelRequiredKeys(planOutputSchema(), planSample);
    expectTopLevelRequiredKeys(planOutputSchema(), planStreamSample);
    expectTopLevelRequiredKeys(backfillOutputSchema(), backfillSample);
    expectTopLevelRequiredKeys(backfillOutputSchema(), backfillStreamSample);
    expectTopLevelRequiredKeys(maintainOutputSchema(), maintainSample);
    expectTopLevelRequiredKeys(maintainOutputSchema(), maintainStreamSample);

    // Advertised schemas document the stream-aware fields.
    const planSchemaJson = JSON.stringify(planOutputSchema());
    expect(planSchemaJson).toContain("streams");
    expect(planSchemaJson).toContain("currentVersion");
    expect(planSchemaJson).toContain("tracks");
    expect(planSchemaJson).toContain("supersedes");
    const backfillSchemaJson = JSON.stringify(backfillOutputSchema());
    expect(backfillSchemaJson).toContain("streams");
    expect(backfillSchemaJson).toContain("currentVersion");
    expect(backfillSchemaJson).toContain("tracks");
    expect(backfillSchemaJson).toContain("supersedes");
    const maintainSchemaJson = JSON.stringify(maintainOutputSchema());
    expect(maintainSchemaJson).toContain("streams");
    expect(maintainSchemaJson).toContain("currentVersion");
    expect(maintainSchemaJson).toContain("tracks");
    expect(maintainSchemaJson).toContain("supersedes");

    expect(() => planAgentResponseSchema.parse(planSample)).not.toThrow();
    expect(() => planAgentResponseSchema.parse(planStreamSample)).not.toThrow();
    expect(() => backfillAgentResponseSchema.parse(backfillSample)).not.toThrow();
    expect(() => backfillAgentResponseSchema.parse(backfillStreamSample)).not.toThrow();
    expect(() => maintainAgentResponseSchema.parse(maintainSample)).not.toThrow();
    expect(() => maintainAgentResponseSchema.parse(maintainStreamSample)).not.toThrow();
  });
});

function expectTopLevelRequiredKeys(schema: Record<string, unknown>, sample: Record<string, unknown>): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  expect(required.every((key) => typeof key === "string" && key in sample)).toBe(true);
}

class ObjectBackfillAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      mission: "Account capability for sign-in and status.",
      phases: [
        {
          title: "Account",
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
    });
  }
}

class MalformedJsonAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    // syntactically invalid JSON (unterminated string) — extractJsonObject throws
    return '{ "patrol": { "change": "add-status-command", "report": "broken';
  }
}

class IncompleteLastPatrolAgent implements AgentRunner {
  name = "codex" as const;
  async isAvailable() {
    return true;
  }
  async run() {
    return JSON.stringify({
      // lastPatrol here is incomplete (no report/at) — used to crash strict parse.
      state: {
        version: 1,
        updatedAt: new Date().toISOString(),
        mission: "Account",
        phases: [],
        lastPatrol: { change: "add-status-command", verdict: "WARN" },
        unlinkedChanges: []
      },
      patrol: {
        change: "add-status-command",
        report: `# Overseer 巡检报告 · add-status-command
## 概要
Declared output contract changed without a matching change spec.
## 发现
| # | 维度 | 严重度 | 位置(文件:符号) | 说明 | 建议 |
| 1 | 接口契约 | BLOCK | openspec/specs/account/spec.md:status | broke declared contract | revert or declare |
## 回写建议
- 无

VERDICT: BLOCK
`
      },
      notes: []
    });
  }
}

async function openspecRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-robust-"));
  await mkdir(join(root, "openspec", "specs", "account"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "account", "spec.md"), "# Account\n", "utf8");
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await archivedChange(root, "2026-06-01-add-login", "Add login flow");
  await archivedChange(root, "2026-05-01-old", "Old approach");
  await activeChange(root, "add-status-command", "Add status command");
  await writeJson(join(root, ".specmarten.json"), defaultConfig("openspec"));
  return root;
}

async function archivedChange(root: string, id: string, title: string): Promise<void> {
  const dir = join(root, "openspec", "changes", "archive", id);
  await mkdir(join(dir, "specs", "account"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), `# ${title}\n`, "utf8");
  await writeFile(join(dir, "specs", "account", "spec.md"), "## ADDED Requirements\n", "utf8");
}

async function activeChange(root: string, id: string, title: string): Promise<void> {
  const dir = join(root, "openspec", "changes", id);
  await mkdir(join(dir, "specs", "account"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), `# ${title}\n`, "utf8");
  await writeFile(join(dir, "specs", "account", "spec.md"), "## ADDED Requirements\n", "utf8");
}
