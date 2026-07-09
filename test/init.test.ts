import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { registerInitCommand, runInit } from "../src/commands/init.js";
import { readJson, pathExists } from "../src/util/fs.js";
import { collectPhases, stateSchema } from "../src/core/state/schema.js";
import { configSchema } from "../src/config/config.js";
import { codexSkillTemplates, SPECMARTEN_PLAN_SKILL_NAME } from "../src/hooks/codex-skills.js";
import { claudeTemplateFiles } from "../src/templates/index.js";
import { SPECMARTEN_CONTEXT_VERSION } from "../src/core/context/plan-context.js";

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalCodexHome = process.env.CODEX_HOME;
const originalHeadless = process.env.SPECMARTEN_HEADLESS;

afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  process.env.CODEX_HOME = originalCodexHome;
  process.env.SPECMARTEN_HEADLESS = originalHeadless;
  vi.restoreAllMocks();
});

describe("init", () => {
  it("fills defaults for minimal hand-written config", () => {
    const config = configSchema.parse({ specBackend: "openspec" });

    expect(config.agent.prefer).toEqual(["codex", "claude", "gemini"]);
    expect(config.maintain).toEqual({ trigger: "git-post-commit", autoRenderViews: true });
    expect(config.overseer.blocking).toBe("advisory");
    expect(config.dashboard.autoOpen).toBe(false);
    expect(config.language.content).toBe("en");
    expect(config.backfill).toEqual({ groupBy: "capability", useGit: true });
  });

  it("keeps the README configuration example parseable", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const match = /## Configuration[\s\S]*?```json\n([\s\S]*?)\n```/.exec(readme);

    expect(match?.[1]).toBeTruthy();
    const config = configSchema.parse(JSON.parse(match?.[1] ?? "{}"));

    expect(config.specBackend).toBe("openspec");
    expect(config.maintain.autoRenderViews).toBe(true);
    expect(config.backfill.useGit).toBe(true);
  });

  it("fails clearly when no OpenSpec project is present", async () => {
    const root = await tempRoot();

    await expect(runInit({ root, noClaude: true, noGitHook: true })).rejects.toThrow(
      "Run `openspec init` first"
    );
  });

  it("creates SpecMarten scaffolding for a greenfield OpenSpec project", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);

    const summary = await runInit({ root, noClaude: true, noCodex: true, noGitHook: true });

    expect(summary.projectType).toBe("greenfield");
    expect(summary.nextAction).toContain("$specmarten-plan");
    expect(await pathExists(join(root, "specmarten", "mission.md"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "tech-stack.md"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "standards", "hard-rules.md"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "baseline", "baseline.json"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "reports"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "roadmap.md"))).toBe(true);
    expect(await pathExists(join(root, "specmarten", "dashboard.html"))).toBe(true);

    const state = stateSchema.parse(await readJson(join(root, "specmarten", "state.json")));
    expect(state.version).toBe(2);
    expect(state.baseline?.specsHash).toMatch(/^sha256:/);

    const config = configSchema.parse(await readJson(join(root, ".specmarten.json")));
    expect(config.specBackend).toBe("openspec");
    expect(config.agent.prefer).toEqual(["codex", "claude", "gemini"]);
    expect(config.language.content).toBe("en");
  });

  it("is idempotent and does not overwrite user-confirmed global files", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await runInit({ root, noClaude: true, noCodex: true, noGitHook: true });

    const missionPath = join(root, "specmarten", "mission.md");
    await writeFile(missionPath, "# Mission\n\nUser confirmed text.\n", "utf8");

    const second = await runInit({ root, noClaude: true, noCodex: true, noGitHook: true });

    expect(second.preserved).toContain("specmarten/mission.md");
    await expect(readFile(missionPath, "utf8")).resolves.toContain("User confirmed text.");
  });

  it("detects brownfield OpenSpec projects without running AI backfill by default", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, "openspec", "changes", "add-json-output"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "add-json-output", "proposal.md"), "# Add JSON output\n");
    const agent = new FakeInitAgent();

    const summary = await runInit({
      root,
      noClaude: true,
      noCodex: true,
      noGitHook: true,
      agentRunner: agent
    });

    expect(summary.projectType).toBe("brownfield");
    expect(summary.backfill).toBeUndefined();
    expect(summary.nextAction).toContain("$specmarten-backfill");
    expect(agent.runs).toBe(0);
    const state = stateSchema.parse(await readJson(join(root, "specmarten", "state.json")));
    expect(state.draft).not.toBe(true);
    expect(collectPhases(state)).toEqual([]);
  });

  it("runs brownfield AI backfill when headless is explicit", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, "openspec", "changes", "add-json-output"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "add-json-output", "proposal.md"), "# Add JSON output\n");
    const agent = new FakeInitAgent();

    const summary = await runInit({
      root,
      noClaude: true,
      noCodex: true,
      noGitHook: true,
      headless: true,
      agentRunner: agent
    });

    expect(summary.projectType).toBe("brownfield");
    expect(summary.backfill?.tasks).toBe(1);
    expect(summary.nextAction).toContain("promote");
    expect(agent.runs).toBe(1);
    const state = stateSchema.parse(await readJson(join(root, "specmarten", "state.json")));
    expect(state.draft).toBe(true);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "in-progress",
      changes: ["add-json-output"]
    });
  });

  it("honors SPECMARTEN_HEADLESS=1 in the CLI init path", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, "openspec", "changes", "add-json-output"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "add-json-output", "proposal.md"), "# Add JSON output\n");
    await writeFakeCodex(bin);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SPECMARTEN_HEADLESS = "1";
    process.chdir(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerInitCommand(program);
    await program.parseAsync(["node", "specmarten", "init", "--no-claude", "--no-codex", "--no-git-hook"], {
      from: "node"
    });

    const state = stateSchema.parse(await readJson(join(root, "specmarten", "state.json")));
    expect(state.draft).toBe(true);
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      status: "in-progress",
      changes: ["add-json-output"]
    });
    expect(log.mock.calls.flat().join("\n")).not.toContain("--minimal skipped git hook installation");
  });

  it("bootstraps by invoking the native openspec CLI when requested", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const openspec = join(bin, "openspec");
    await writeFile(
      openspec,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > openspec-args.txt\nmkdir -p openspec/specs openspec/changes/archive\n",
      "utf8"
    );
    await chmod(openspec, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const summary = await runInit({ root, bootstrap: true, noClaude: true, noCodex: true, noGitHook: true });

    expect(summary.projectType).toBe("greenfield");
    expect(await pathExists(join(root, "openspec"))).toBe(true);
    await expect(readFile(join(root, "openspec-args.txt"), "utf8")).resolves.toBe("init\n--tools\nnone\n--force\n");
  });

  it("accepts --bootstrap and --minimal skips optional integrations", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const openspec = join(bin, "openspec");
    await writeFile(
      openspec,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > openspec-args.txt\nmkdir -p openspec/specs openspec/changes/archive\n",
      "utf8"
    );
    await chmod(openspec, 0o755);
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.chdir(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerInitCommand(program);
    await program.parseAsync(["node", "specmarten", "init", "--bootstrap", "--minimal"], {
      from: "node"
    });

    await expect(readFile(join(root, "openspec-args.txt"), "utf8")).resolves.toBe("init\n--tools\nnone\n--force\n");
    expect(await pathExists(join(root, "specmarten", "state.json"))).toBe(true);
    expect(await pathExists(join(root, "AGENTS.md"))).toBe(false);
    expect(await pathExists(join(root, ".claude", "commands", "sm-plan.md"))).toBe(false);
    expect(await pathExists(join(root, ".claude", "settings.json"))).toBe(false);
    expect(await pathExists(join(root, ".git", "hooks", "post-commit"))).toBe(false);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Skipped by --minimal.");
    expect(output).toContain("--minimal skipped git hook installation");
    expect(output).toContain("run `specmarten closeout`");
    expect(output).toContain("refresh baseline");
    expect(output).toContain("run `specmarten init` without `--minimal`");
  });

  it("installs a git post-commit fallback hook when .git is present", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, ".git"), { recursive: true });

    const summary = await runInit({ root, noClaude: true, noCodex: true });

    expect(summary.gitHook.installed).toBe(true);
    await expect(readFile(join(root, ".git", "hooks", "post-commit"), "utf8")).resolves.toContain(
      "specmarten reconcile"
    );
  });

  it("migrates an existing managed git hook from maintain to reconcile", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    const hookPath = join(root, ".git", "hooks", "post-commit");
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await writeFile(
      hookPath,
      `#!/bin/sh
echo user-owned
# >>> specmarten hook
if command -v specmarten >/dev/null 2>&1; then
  specmarten maintain >/dev/null 2>&1 || true
fi
# <<< specmarten hook
echo after
`,
      "utf8"
    );

    const summary = await runInit({ root, noClaude: true, noCodex: true });
    const hook = await readFile(hookPath, "utf8");

    expect(summary.gitHook.installed).toBe(true);
    expect(hook).toContain("echo user-owned");
    expect(hook).toContain("echo after");
    expect(hook).toContain("specmarten reconcile");
    expect(hook).not.toContain("specmarten maintain");
    expect(hook.match(/>>> specmarten hook/g)).toHaveLength(1);
  });

  it("installs Claude Code agent files and a deterministic PostToolUse hook when .claude is present", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await writeFile(
      join(root, ".claude", "commands", "os-plan.md"),
      `Ask the user for the requirement, then run:

\`\`\`sh
specmarten plan "<requirement>"
\`\`\`
`,
      "utf8"
    );
    await writeFile(
      join(root, ".claude", "commands", "os-status.md"),
      `Run:

\`\`\`sh
specmarten status
\`\`\`
`,
      "utf8"
    );
    await writeFile(join(root, ".claude", "commands", "user-owned.md"), "keep me\n", "utf8");

    const summary = await runInit({ root, noCodex: true, noGitHook: true });
    const managedCommands = [
      "commands/sm-run.md",
      "commands/sm-plan.md",
      "commands/sm-backfill.md",
      "commands/sm-check.md",
      "commands/sm-maintain.md",
      "commands/sm-status.md"
    ];

    expect(summary.claude.detected).toBe(true);
    expect(summary.claude.filesWritten).toEqual(expect.arrayContaining(managedCommands));
    expect(Object.keys(claudeTemplateFiles)).toEqual(expect.arrayContaining(managedCommands));
    expect(Object.keys(claudeTemplateFiles)).not.toContain("commands/os-plan.md");
    expect(Object.keys(claudeTemplateFiles)).not.toContain("commands/os-status.md");
    expect(claudeTemplateFiles["commands/sm-run.md"]).toContain("The current Claude Code session owns the full task");
    expect(claudeTemplateFiles["commands/sm-run.md"]).toContain("$ARGUMENTS");
    expect(claudeTemplateFiles["commands/sm-run.md"]).toContain("openspec/changes/<change-id>/");
    expect(claudeTemplateFiles["commands/sm-run.md"]).toContain("specmarten state write-draft --kind maintain");
    expect(claudeTemplateFiles["commands/sm-run.md"]).toContain("Do not commit, tag, publish, or push");
    expect(claudeTemplateFiles["commands/sm-plan.md"]).toContain(
      'specmarten context --workflow plan --requirement "$ARGUMENTS" --json'
    );
    expect(claudeTemplateFiles["commands/sm-plan.md"]).toContain("specmarten state write-draft --kind plan");
    expect(claudeTemplateFiles["commands/sm-plan.md"]).toContain(
      `specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\``
    );
    expect(claudeTemplateFiles["commands/sm-backfill.md"]).toContain("specmarten state write-draft --kind backfill");
    expect(claudeTemplateFiles["commands/sm-backfill.md"]).toContain(
      `specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\``
    );
    expect(claudeTemplateFiles["commands/sm-check.md"]).toContain(
      'specmarten context --workflow check --change "$ARGUMENTS" --json'
    );
    expect(claudeTemplateFiles["commands/sm-check.md"]).toContain(
      `specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\``
    );
    expect(claudeTemplateFiles["commands/sm-maintain.md"]).toContain("specmarten context --workflow maintain --json");
    expect(claudeTemplateFiles["commands/sm-maintain.md"]).toContain(
      `specmartenContext\` is not \`${SPECMARTEN_CONTEXT_VERSION}\``
    );
    expect(claudeTemplateFiles["commands/sm-maintain.md"]).toContain("specmarten render");
    expect(claudeTemplateFiles["commands/sm-status.md"]).toContain("specmarten validate");
    expect(claudeTemplateFiles["commands/sm-status.md"]).toContain("Do not edit files.");
    expect(claudeTemplateFiles["commands/sm-plan.md"]).toContain("specmarten status --summary-json");
    expect(claudeTemplateFiles["commands/sm-plan.md"]).toContain("remaining tasks");
    expect(claudeTemplateFiles["commands/sm-status.md"]).toContain("read-only global context checkpoint");
    await expect(readFile(join(root, ".claude", "agents", "maintainer.md"), "utf8")).resolves.toContain(
      "SpecMarten"
    );
    await expect(readFile(join(root, ".claude", "agents", "maintainer.md"), "utf8")).resolves.toContain(
      "specmarten status --summary-json"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-plan.md"), "utf8")).resolves.toBe(
      claudeTemplateFiles["commands/sm-plan.md"]
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-run.md"), "utf8")).resolves.toBe(
      claudeTemplateFiles["commands/sm-run.md"]
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-backfill.md"), "utf8")).resolves.toContain(
      "specmarten context --workflow backfill --json"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-check.md"), "utf8")).resolves.toContain(
      "specmarten patrol report"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-maintain.md"), "utf8")).resolves.toContain(
      "specmarten state write-draft --kind maintain"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-status.md"), "utf8")).resolves.toContain(
      "specmarten status --summary-json"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-plan.md"), "utf8")).resolves.toContain(
      "$ARGUMENTS"
    );
    await expect(readFile(join(root, ".claude", "commands", "sm-check.md"), "utf8")).resolves.toContain(
      "$ARGUMENTS"
    );
    await expect(readFile(join(root, ".claude", "commands", "user-owned.md"), "utf8")).resolves.toBe("keep me\n");
    const installedCommandText = await Promise.all(
      managedCommands.map((relativePath) => readFile(join(root, ".claude", relativePath), "utf8"))
    );
    expect(installedCommandText.join("\n")).toContain("current Claude Code session");
    expect(installedCommandText.join("\n")).toContain("Do not call `claude -p`, `codex exec`, `gemini -p`");
    expect(installedCommandText.join("\n")).toContain("remaining tasks");

    const settings = await readFile(join(root, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("specmarten reconcile");
    expect(settings).not.toContain("specmarten status --summary-json");
    expect(settings).not.toContain("specmarten maintain");
    expect(settings).not.toContain("claude -p");
    expect(settings).not.toContain("codex exec");
    expect(settings).not.toContain("gemini -p");
  });

  it("migrates old Claude settings hooks even when reconcile is already present", async () => {
    const root = await tempRoot();
    await createOpenSpec(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { hooks: [{ type: "command", command: "specmarten maintain >/dev/null 2>&1 || true" }] },
              { hooks: [{ type: "command", command: "specmarten reconcile >/dev/null 2>&1 || true" }] }
            ]
          },
          untouched: true
        },
        null,
        2
      ),
      "utf8"
    );

    const summary = await runInit({ root, noCodex: true, noGitHook: true });
    const settings = await readFile(join(root, ".claude", "settings.json"), "utf8");

    expect(summary.claude.filesWritten).toContain("settings.json");
    expect(settings).toContain('"untouched": true');
    expect(settings).toContain("specmarten reconcile");
    expect(settings).not.toContain("specmarten maintain");
  });

  it("installs Codex AGENTS.md guidance and skill without a headless hook when codex is present", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const codexHome = await tempRoot();
    process.env.CODEX_HOME = codexHome;
    await createOpenSpec(root);
    await writeFile(join(root, "AGENTS.md"), "# Existing Guidance\n\nKeep this.\n", "utf8");
    const codex = join(bin, "codex");
    await writeFile(codex, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(codex, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const summary = await runInit({ root, noClaude: true, noGitHook: true });

    expect(summary.codex.detected).toBe(true);
    expect(summary.codexSkills?.files[0]?.action).toBe("created");
    expect(summary.codex.agentsMd?.action).toBe("updated");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain(
      "<!-- BEGIN SPECMARTEN MANAGED BLOCK -->"
    );
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("specmarten status --summary-json");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("$specmarten-status");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("openspec/changes/<change-id>/");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain(
      "do not edit `openspec/specs/` directly"
    );
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("Keep this.");
    expect(await pathExists(join(root, ".codex", "hooks.json"))).toBe(false);

    const second = await runInit({ root, noClaude: true, noGitHook: true });
    expect(second.codexSkills?.files[0]?.action).toBe("unchanged");
    expect(await pathExists(join(root, ".codex", "hooks.json"))).toBe(false);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/BEGIN SPECMARTEN MANAGED BLOCK/g)).toHaveLength(1);
    await expect(readFile(join(codexHome, "skills", SPECMARTEN_PLAN_SKILL_NAME, "SKILL.md"), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_PLAN_SKILL_NAME]
    );
  });

  it("does not install global Codex skills when the codex CLI is missing", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const codexHome = await tempRoot();
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = bin;
    await createOpenSpec(root);

    const summary = await runInit({ root, noClaude: true, noGitHook: true });

    expect(summary.codex.detected).toBe(false);
    expect(summary.codexSkills).toBeNull();
    expect(await pathExists(join(codexHome, "skills"))).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-test-"));
}

async function createOpenSpec(root: string): Promise<void> {
  await mkdir(join(root, "openspec", "specs", "example"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "example", "spec.md"), "# Example Spec\n", "utf8");
}

class FakeInitAgent implements AgentRunner {
  name = "codex" as const;
  runs = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    this.runs += 1;
    return JSON.stringify({
      mission: "Init sample",
      phases: [{ title: "MVP", tasks: [{ title: "Add JSON output", changes: ["add-json-output"] }] }],
      unlinkedChanges: [],
      lowConfidence: [],
      superseded: [],
      notes: []
    });
  }
}

async function writeFakeCodex(bin: string): Promise<void> {
  const codex = join(bin, "codex");
  await writeFile(
    codex,
    `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
json='{"mission":"Init sample","phases":[{"title":"MVP","tasks":[{"title":"Add JSON output","changes":["add-json-output"]}]}],"unlinkedChanges":[],"lowConfidence":[],"superseded":[],"notes":[]}'
if [ -n "$out" ]; then
  printf '%s' "$json" > "$out"
else
  printf '%s' "$json"
fi
`,
    "utf8"
  );
  await chmod(codex, 0o755);
}
