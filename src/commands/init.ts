import { Command } from "commander";
import { join } from "node:path";
import { TOOL } from "../constants.js";
import type { AgentRunner } from "../adapters/agent/types.js";
import { detectAvailableAgents } from "../adapters/agent/detect.js";
import { OpenSpecBackend } from "../adapters/spec-backend/openspec.js";
import { detectProjectType, readConfig, writeDefaultConfigIfMissing, type ProjectType } from "../config/config.js";
import { runBackfill } from "../core/backfill/backfill.js";
import type { BackfillSummary } from "../core/backfill/draft.js";
import { createBaselineIfMissing } from "../core/baseline.js";
import { writeMaintainMarker } from "../core/maintenance/marker.js";
import { renderViews } from "../core/renderers/index.js";
import { readState, writeInitialStateIfMissing } from "../core/state/store.js";
import { installClaudeCodeFiles, type ClaudeInstallResult } from "../hooks/claude-code.js";
import { installCodexFiles, type CodexInstallResult } from "../hooks/codex.js";
import { installCodexSkills, type CodexSkillInstallResult } from "../hooks/codex-skills.js";
import { installGitPostCommitHook, type GitHookInstallResult } from "../hooks/git.js";
import { templateFiles } from "../templates/index.js";
import { ensureDir, pathExists, writeTextIfMissing } from "../util/fs.js";
import { runProcess } from "../util/process.js";
import { UserFacingError } from "../util/errors.js";
import { createHeadlessAgent, HEADLESS_OPTION_DESCRIPTION, isHeadlessRequested } from "./execution-mode.js";

export interface InitOptions {
  root?: string;
  yes?: boolean;
  bootstrap?: boolean;
  minimal?: boolean;
  noClaude?: boolean;
  noCodex?: boolean;
  noGitHook?: boolean;
  headless?: boolean;
  agentRunner?: AgentRunner;
}

export interface InitSummary {
  root: string;
  projectType: ProjectType;
  created: string[];
  preserved: string[];
  availableAgents: string[];
  claude: ClaudeInstallResult;
  codex: CodexInstallResult;
  codexSkills: CodexSkillInstallResult | null;
  gitHook: GitHookInstallResult;
  backfill?: BackfillSummary;
  nextAction: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize SpecMarten files, generated views, and detected integrations.")
    .option("-y, --yes", "accept defaults")
    .option("--bootstrap", "run native `openspec init` before initializing SpecMarten")
    .option("--minimal", "initialize only OpenSpec/SpecMarten basics; skip Codex, Claude Code, and git hook files")
    .option("--no-claude", "skip Claude Code agent and hook files")
    .option("--no-codex", "skip Codex AGENTS.md guidance and project hook files")
    .option("--no-git-hook", "skip git post-commit fallback hook")
    .option("--headless", HEADLESS_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      "\nBy default, init may write specmarten/, .specmarten.json, Codex skills or AGENTS.md guidance, Claude Code files, and a git post-commit hook when those integrations are detected. Use --minimal to create only OpenSpec/SpecMarten project files."
    )
    .action(async (options: {
      yes?: boolean;
      bootstrap?: boolean;
      minimal?: boolean;
      claude?: boolean;
      codex?: boolean;
      gitHook?: boolean;
      headless?: boolean;
    }) => {
      const headless = isHeadlessRequested(options.headless || program.opts().headless);
      const summary = await runInit({
        root: process.cwd(),
        yes: options.yes,
        bootstrap: options.bootstrap,
        minimal: options.minimal,
        noClaude: options.minimal || options.claude === false,
        noCodex: options.minimal || options.codex === false,
        noGitHook: options.minimal || options.gitHook === false,
        headless
      });

      printInitSummary(summary);
    });
}

export async function runInit(options: InitOptions = {}): Promise<InitSummary> {
  const root = options.root ?? process.cwd();
  const noClaude = options.minimal || options.noClaude;
  const noCodex = options.minimal || options.noCodex;
  const noGitHook = options.minimal || options.noGitHook;
  const backend = new OpenSpecBackend(root);

  if (!(await backend.isPresent())) {
    if (!options.bootstrap) {
      throw new UserFacingError(
        `${TOOL.displayName} needs an OpenSpec project. Run \`openspec init\` first, or retry with \`${TOOL.cliName} init --bootstrap\`.`
      );
    }

    await bootstrapOpenSpec(root);
    if (!(await backend.isPresent())) {
      throw new UserFacingError("Native `openspec init` completed, but no OpenSpec directory was detected.");
    }
  }

  const created: string[] = [];
  const preserved: string[] = [];

  for (const dir of [
    join(root, TOOL.dataDir),
    join(root, TOOL.dataDir, "standards"),
    join(root, TOOL.dataDir, "baseline"),
    join(root, TOOL.dataDir, "reports")
  ]) {
    if (await pathExists(dir)) {
      preserved.push(relativeDisplay(root, dir));
    } else {
      await ensureDir(dir);
      created.push(relativeDisplay(root, dir));
    }
  }

  for (const [relativePath, content] of Object.entries(templateFiles)) {
    const target = join(root, TOOL.dataDir, relativePath);
    if (await writeTextIfMissing(target, content)) {
      created.push(relativeDisplay(root, target));
    } else {
      preserved.push(relativeDisplay(root, target));
    }
  }

  if (await writeDefaultConfigIfMissing(root)) {
    created.push(TOOL.configFile);
  } else {
    preserved.push(TOOL.configFile);
  }

  const baseline = await createBaselineIfMissing(root, backend);
  const stateCreated = await writeInitialStateIfMissing(root, { baseline });
  if (stateCreated) {
    created.push(`${TOOL.dataDir}/state.json`);
  } else {
    preserved.push(`${TOOL.dataDir}/state.json`);
  }

  await renderViews(root, await readState(root));
  created.push(`${TOOL.dataDir}/roadmap.md`);
  created.push(`${TOOL.dataDir}/dashboard.html`);

  const config = await readConfig(root);
  const availableAgents = await detectAvailableAgents(config.agent.prefer);
  const claude = noClaude ? { detected: false, filesWritten: [] } : await installClaudeCodeFiles(root);
  const codex = noCodex
    ? { detected: false, skippedReason: options.minimal ? "Skipped by --minimal." : "Skipped by --no-codex." }
    : await installCodexFiles(root);
  const codexSkills = noCodex || !codex.detected ? null : await installCodexSkills({ overwrite: false });
  const gitHook = noGitHook
    ? { installed: false, skippedReason: options.minimal ? "Skipped by --minimal." : "Skipped by --no-git-hook." }
    : await installGitPostCommitHook(root);
  const projectType = await detectProjectType(backend);
  const backfill =
    projectType === "brownfield" && options.headless
      ? await runBackfill({
          root,
          backend,
          agent: options.agentRunner ?? (await createHeadlessAgent(config.agent.prefer)),
          groupBy: config.backfill.groupBy
        })
      : undefined;
  await writeMaintainMarker(root, await backend.getCurrentMarker());

  return {
    root,
    projectType,
    created,
    preserved,
    availableAgents,
    claude,
    codex,
    codexSkills,
    gitHook,
    backfill,
    nextAction:
      projectType === "greenfield"
        ? "Refresh or restart Codex, then run `$specmarten-plan your requirement` to draft the roadmap."
        : backfill
          ? `Review \`${TOOL.dataDir}/roadmap.md\` and run \`${TOOL.cliName} promote\` when the draft is right.`
          : "Refresh or restart Codex, then run `$specmarten-backfill` to draft the roadmap from existing OpenSpec changes."
  };
}

function printInitSummary(summary: InitSummary): void {
  console.log(`${TOOL.displayName} initialized in ${summary.root}`);
  console.log(`Project type: ${summary.projectType}`);
  if (summary.availableAgents.length === 0) {
    console.log("Agent CLIs: none detected yet; AI commands will fail until claude, codex, or gemini is installed.");
  } else {
    console.log(`Agent CLIs: ${summary.availableAgents.join(", ")}`);
  }
  if (summary.claude.detected) {
    console.log(`Claude Code files: ${summary.claude.filesWritten.length} written`);
  }
  if (summary.codex.detected) {
    const agentsMd = summary.codex.agentsMd
      ? `AGENTS.md ${summary.codex.agentsMd.action}`
      : "AGENTS.md skipped";
    console.log(`Codex files: ${agentsMd}; no headless hook installed`);
  } else {
    console.log(`Codex files: ${summary.codex.skippedReason}`);
  }
  if (summary.codexSkills) {
    const actions = summary.codexSkills.files.map((file) => file.action).join(", ");
    console.log(`Codex skills: ${actions} in ${summary.codexSkills.skillsDir}`);
  } else {
    console.log(`Codex skills: ${summary.codex.skippedReason ?? "skipped."}`);
  }
  console.log(summary.gitHook.installed ? "Git hook: installed" : `Git hook: ${summary.gitHook.skippedReason}`);
  if (summary.gitHook.skippedReason === "Skipped by --minimal.") {
    console.log(
      "WARNING: --minimal skipped git hook installation. After OpenSpec archive, run `specmarten closeout` to reconcile, render, refresh baseline, and validate."
    );
    console.log("To install integrations later, run `specmarten init` without `--minimal`.");
  }
  if (summary.backfill) {
    console.log(`Backfill draft: ${summary.backfill.phases} phases, ${summary.backfill.tasks} tasks`);
  }
  console.log(summary.nextAction);
}

async function bootstrapOpenSpec(root: string): Promise<void> {
  try {
    const result = await runProcess("openspec", ["init", "--tools", "none", "--force"], { cwd: root });
    if (result.code !== 0) {
      throw new UserFacingError(`Native \`openspec init\` failed: ${result.stderr.trim()}`);
    }
  } catch (error) {
    if (error instanceof UserFacingError) {
      throw error;
    }

    throw new UserFacingError(
      "Could not run native `openspec init`. Install OpenSpec and run it directly, then retry `specmarten init`."
    );
  }
}

function relativeDisplay(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
