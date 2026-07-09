import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContextCommand } from "../src/commands/context.js";
import { defaultConfig, writeContentLanguage } from "../src/config/config.js";
import { DEFAULT_CONTENT_LANGUAGE } from "../src/core/content-language.js";
import { TOOL } from "../src/constants.js";
import { buildBackfillContext } from "../src/core/context/backfill-context.js";
import { buildCheckContext } from "../src/core/context/check-context.js";
import { buildMaintainContext } from "../src/core/context/maintain-context.js";
import { buildPlanContext } from "../src/core/context/plan-context.js";
import { backfillInstruction } from "../src/core/backfill/prompt.js";
import { backfillOutputSchema } from "../src/core/backfill/schema.js";
import { maintainInstruction } from "../src/core/maintenance/prompt.js";
import { maintainOutputSchema } from "../src/core/maintenance/schema.js";
import { checkInstruction, patrolReportOutputSchema } from "../src/core/overseer/prompt.js";
import { buildPlanPrompt, planInstruction } from "../src/core/planner/prompt.js";
import { renderDashboardHtml } from "../src/core/renderers/dashboard.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, writeState } from "../src/core/state/store.js";
import { writeJson } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("context", () => {
  it("builds a plan context envelope with state, global docs, instruction, schema, and next steps", async () => {
    const root = await createContextProject();

    const envelope = await buildPlanContext({ root, requirement: "  Build client command plan flow  " });

    expect(envelope).toMatchObject({
      specmartenContext: 1,
      tool: TOOL.cliName,
      version: TOOL.version,
      workflow: "plan",
      root,
      requirement: "Build client command plan flow",
      contentLanguage: DEFAULT_CONTENT_LANGUAGE,
      next: {
        writeDraft: "specmarten state write-draft --kind plan",
        render: "specmarten render",
        promote: "specmarten promote"
      }
    });
    expect(envelope.state.mission).toBe("Existing mission");
    expect(envelope.globalDocs.mission).toContain("[TODO: user mission]");
    expect(envelope.globalDocs.techStack).toContain("[TODO: stack]");
    expect(envelope.globalDocs.standards).toEqual([
      {
        path: "standards/hard-rules.md",
        content: "# Hard Rules\n\n- [HARD] Keep context deterministic.\n"
      }
    ]);
    expect(envelope.instruction).toBe(planInstruction());
    expect(envelope.instruction).toContain("use supersedes by default");
    expect(envelope.instruction).toContain("use parallel only");
    expect(envelope.outputSchema).toMatchObject({
      type: "object",
      required: ["mission", "questions", "notes"]
    });
    const properties = envelope.outputSchema.properties as Record<string, { items: { required: string[] } }>;
    // Stream-aware fields are advertised alongside the legacy phases shape.
    expect(properties).toHaveProperty("streams");
    expect(properties).toHaveProperty("currentVersion");
    expect(properties).toHaveProperty("phases");
    expect(properties.phases.items.required).not.toContain("status");
  });

  it("uses the same plan instruction for context and the headless planner prompt", async () => {
    const root = await createContextProject();
    const envelope = await buildPlanContext({ root, requirement: "Build context" });
    const prompt = buildPlanPrompt({
      requirement: "Build context",
      state: envelope.state,
      contentLanguage: envelope.contentLanguage,
      missionDoc: envelope.globalDocs.mission,
      techStackDoc: envelope.globalDocs.techStack,
      standardsDocs: envelope.globalDocs.standards
    });

    expect(envelope.instruction).toBe(planInstruction());
    expect(prompt.startsWith(planInstruction())).toBe(true);
  });

  it("uses the configured content language in generation context", async () => {
    const root = await createContextProject();
    await writeJson(join(root, ".specmarten.json"), {
      ...defaultConfig(),
      language: { content: "zh" }
    });

    const envelope = await buildPlanContext({ root, requirement: "Build context" });

    expect(envelope.contentLanguage).toBe("zh");
    expect(envelope.instruction).toContain("Generated content language:");
    expect(envelope.instruction).toContain("in Chinese");
    expect(envelope.instruction).toContain("Preserve existing state text");
  });

  it("switches future generation language without translating existing state text", async () => {
    const root = await createContextProject();
    await writeContentLanguage(root, "zh");

    const envelope = await buildPlanContext({ root, requirement: "新增报表能力" });
    const phase = collectPhases(envelope.state)[0];
    const html = renderDashboardHtml(envelope.state, { contentLanguage: envelope.contentLanguage });

    expect(envelope.contentLanguage).toBe("zh");
    expect(envelope.instruction).toContain("in Chinese");
    expect(envelope.requirement).toBe("新增报表能力");
    expect(envelope.state.mission).toBe("Existing mission");
    expect(phase?.title).toBe("Existing phase");
    expect(phase?.tasks[0]?.title).toBe("Existing task");
    expect(html).toContain("data-content-language=\"zh\"");
    expect(html).toContain("data-i18n-user-text=\"Existing task\"");
    expect(html).toContain("项目状态看板");
  });

  it("degrades missing docs and missing state to empty docs plus initial state", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-context-missing-test-"));

    const envelope = await buildPlanContext({ root });

    expect(envelope.requirement).toBeNull();
    expect(envelope.state).toMatchObject({
      version: 2,
      mission: "",
      currentVersion: "",
      streams: [],
      baseline: null,
      unlinkedChanges: []
    });
    expect(envelope.globalDocs).toEqual({
      mission: "",
      techStack: "",
      standards: []
    });
  });

  it("exposes a deterministic context command that prints valid JSON", async () => {
    const root = await createContextProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, "context", "--workflow", "plan", "--requirement", "Build JSON envelope", "--json");

    const output = String(log.mock.calls.at(-1)?.[0]);
    const envelope = JSON.parse(output) as Awaited<ReturnType<typeof buildPlanContext>>;

    expect(envelope.specmartenContext).toBe(1);
    expect(envelope.workflow).toBe("plan");
    expect(envelope.requirement).toBe("Build JSON envelope");
    expect(envelope.instruction).toBe(planInstruction());
  });

  it("builds a backfill context envelope with OpenSpec snapshots and schema", async () => {
    const root = await createBackfillContextProject();

    const envelope = await buildBackfillContext({ root, groupBy: "time" });

    expect(envelope).toMatchObject({
      specmartenContext: 1,
      tool: TOOL.cliName,
      version: TOOL.version,
      workflow: "backfill",
      root,
      groupBy: "time",
      contentLanguage: DEFAULT_CONTENT_LANGUAGE,
      next: {
        writeDraft: "specmarten state write-draft --kind backfill",
        render: "specmarten render",
        promote: "specmarten promote"
      }
    });
    expect(envelope.state.mission).toBe("Existing mission");
    expect(envelope.openSpec.activeChanges.map((change) => change.id)).toEqual(["add-status-command"]);
    expect(envelope.openSpec.archivedChanges.map((change) => change.id)).toEqual(["2026-06-01-add-login"]);
    expect(envelope.openSpec.specs.map((spec) => spec.id)).toEqual(["account/spec.md"]);
    expect(envelope.openSpec.changes.map((change) => change.id)).toEqual([
      "2026-06-01-add-login",
      "add-status-command"
    ]);
    expect(envelope.openSpec.changes[0]?.specDeltas[0]?.contentPreview).toContain("Login");
    expect(envelope.instruction).toBe(backfillInstruction({ groupBy: "time" }));
    expect(envelope.instruction).toContain("use supersedes by default");
    expect(envelope.instruction).toContain("use parallel only");
    expect(envelope.outputSchema).toEqual(backfillOutputSchema());
  });

  it("exposes a deterministic backfill context command that prints valid JSON", async () => {
    const root = await createBackfillContextProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, "context", "--workflow", "backfill", "--group-by", "flat", "--json");

    const output = String(log.mock.calls.at(-1)?.[0]);
    const envelope = JSON.parse(output) as Awaited<ReturnType<typeof buildBackfillContext>>;

    expect(envelope.specmartenContext).toBe(1);
    expect(envelope.workflow).toBe("backfill");
    expect(envelope.groupBy).toBe("flat");
    expect(envelope.openSpec.changes.length).toBe(2);
    expect(envelope.instruction).toBe(backfillInstruction({ groupBy: "flat" }));
  });

  it("builds a check context envelope with the selected change, baseline specs, triage, and schema", async () => {
    const root = await createCheckContextProject({ withBaseline: true });

    const envelope = await buildCheckContext({ root, change: "add-status-command" });

    expect(envelope).toMatchObject({
      specmartenContext: 1,
      tool: TOOL.cliName,
      version: TOOL.version,
      workflow: "check",
      root,
      change: "add-status-command",
      contentLanguage: DEFAULT_CONTENT_LANGUAGE,
      next: {
        patrolReport: "specmarten patrol report"
      }
    });
    expect(envelope.state.mission).toBe("Existing mission");
    expect(envelope.globalDocs.standards[0]?.path).toBe("standards/hard-rules.md");
    expect(envelope.openSpec.change).toMatchObject({
      id: "add-status-command",
      status: "active"
    });
    expect(envelope.openSpec.change.specDeltas[0]?.contentPreview).toContain("Status command");
    expect(envelope.openSpec.baselineSpecs).toEqual([
      {
        path: "account/spec.md",
        content: "# Baseline Account Spec\n"
      }
    ]);
    expect(envelope.triage.hit).toBe(false);
    expect(envelope.instruction).toBe(checkInstruction());
    expect(envelope.outputSchema).toEqual(patrolReportOutputSchema());
  });

  it("exposes a deterministic check context command and tolerates missing baseline specs", async () => {
    const root = await createCheckContextProject({ withBaseline: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, "context", "--workflow", "check", "--change", "add-status-command", "--json");

    const output = String(log.mock.calls.at(-1)?.[0]);
    const envelope = JSON.parse(output) as Awaited<ReturnType<typeof buildCheckContext>>;

    expect(envelope.specmartenContext).toBe(1);
    expect(envelope.workflow).toBe("check");
    expect(envelope.change).toBe("add-status-command");
    expect(envelope.openSpec.baselineSpecs).toEqual([]);
    expect(envelope.instruction).toBe(checkInstruction());
  });

  it("builds a maintain context envelope with deterministic reconcile results", async () => {
    const root = await createMaintainContextProject();

    const envelope = await buildMaintainContext({ root });
    const tasks = collectPhases(envelope.reconcile.state).flatMap((phase) => phase.tasks);

    expect(envelope).toMatchObject({
      specmartenContext: 1,
      tool: TOOL.cliName,
      version: TOOL.version,
      workflow: "maintain",
      root,
      contentLanguage: DEFAULT_CONTENT_LANGUAGE,
      next: {
        patrolReport: "specmarten patrol report",
        writeDraft: "specmarten state write-draft --kind maintain",
        render: "specmarten render"
      }
    });
    expect(tasks.find((task) => task.changes.includes("2026-06-01-add-login"))?.status).toBe("done");
    expect(tasks.find((task) => task.changes.includes("add-status-command"))?.status).toBe("in-progress");
    expect(envelope.reconcile.unlinkedChanges).toEqual([]);
    expect(envelope.reconcile.hasNewUnlinkedChanges).toBe(false);
    expect(envelope.reconcile.suggestedLinks).toEqual([]);
    expect(envelope.openSpec.changes.map((change) => change.id)).toEqual([
      "2026-06-01-add-login",
      "add-status-command"
    ]);
    expect(envelope.instruction).toBe(maintainInstruction());
    expect(envelope.instruction).toContain("Preserve existing streams");
    expect(envelope.instruction).toContain("use supersedes by default");
    expect(envelope.instruction).toContain("use parallel only");
    expect(envelope.outputSchema).toEqual(maintainOutputSchema());
  });

  it("exposes a deterministic maintain context command that prints valid JSON", async () => {
    const root = await createMaintainContextProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, "context", "--workflow", "maintain", "--json");

    const output = String(log.mock.calls.at(-1)?.[0]);
    const envelope = JSON.parse(output) as Awaited<ReturnType<typeof buildMaintainContext>>;

    expect(envelope.specmartenContext).toBe(1);
    expect(envelope.workflow).toBe("maintain");
    expect(collectPhases(envelope.reconcile.state).length).toBe(1);
    expect(envelope.instruction).toBe(maintainInstruction());
  });

  it("does not import or call AI runner code from the context path", async () => {
    const files = [
      "src/commands/context.ts",
      "src/core/context/backfill-context.ts",
      "src/core/context/check-context.ts",
      "src/core/context/maintain-context.ts",
      "src/core/context/plan-context.ts",
      "src/core/backfill/snapshot.ts",
      "src/core/maintenance/reconcile.ts",
      "src/core/overseer/prompt.ts",
      "src/core/overseer/triage.ts",
      "src/core/planner/input.ts"
    ];
    const sources = await Promise.all(files.map((file) => readFile(join(process.cwd(), file), "utf8")));

    expect(sources.join("\n")).not.toMatch(/adapters\/agent|shell-runner|AgentRunner|createPreferredAgentRunner/);
  });
});

async function runCommand(root: string, ...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerContextCommand(program);
  process.chdir(root);
  await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
}

async function createContextProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-context-test-"));
  await mkdir(join(root, "specmarten", "standards"), { recursive: true });
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Existing mission",
  }, [
      {
        id: "p1",
        title: "Existing phase",
        status: "planned",
        tasks: [{ id: "p1.1", title: "Existing task", status: "todo", changes: [] }]
      }
    ]));
  await writeFile(join(root, "specmarten", "mission.md"), "# Mission\n\n[TODO: user mission]\n", "utf8");
  await writeFile(join(root, "specmarten", "tech-stack.md"), "# Tech Stack\n\n[TODO: stack]\n", "utf8");
  await writeFile(
    join(root, "specmarten", "standards", "hard-rules.md"),
    "# Hard Rules\n\n- [HARD] Keep context deterministic.\n",
    "utf8"
  );
  return root;
}

async function createBackfillContextProject(): Promise<string> {
  const root = await createContextProject();
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
  return root;
}

async function createCheckContextProject(options: { withBaseline: boolean }): Promise<string> {
  const root = await createBackfillContextProject();
  await writeJson(join(root, ".specmarten.json"), defaultConfig());

  if (options.withBaseline) {
    await mkdir(join(root, "specmarten", "baseline", "specs-snapshot", "account"), { recursive: true });
    await writeFile(
      join(root, "specmarten", "baseline", "specs-snapshot", "account", "spec.md"),
      "# Baseline Account Spec\n",
      "utf8"
    );
  }

  return root;
}

async function createMaintainContextProject(): Promise<string> {
  const root = await createBackfillContextProject();
  await writeJson(join(root, ".specmarten.json"), defaultConfig());
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Existing mission",
  }, [
      {
        id: "p1",
        title: "Account",
        status: "in-progress",
        tasks: [
          {
            id: "p1.1",
            title: "Login",
            status: "in-progress",
            changes: ["2026-06-01-add-login"]
          },
          {
            id: "p1.2",
            title: "Status command",
            status: "todo",
            changes: ["add-status-command"]
          }
        ]
      }
    ]));
  return root;
}
