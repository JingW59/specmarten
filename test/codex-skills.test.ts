import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUpdateCommand, runUpdate } from "../src/commands/update.js";
import {
  codexSkillTemplates,
  installCodexSkills,
  SPECMARTEN_BACKFILL_SKILL_NAME,
  SPECMARTEN_CHECK_SKILL_NAME,
  SPECMARTEN_MAINTAIN_SKILL_NAME,
  SPECMARTEN_PLAN_SKILL_NAME,
  SPECMARTEN_RUN_SKILL_NAME,
  SPECMARTEN_STATUS_SKILL_NAME,
  renderSpecMartenBackfillSkill,
  renderSpecMartenCheckSkill,
  renderSpecMartenMaintainSkill,
  renderSpecMartenPlanSkill,
  renderSpecMartenRunSkill,
  renderSpecMartenStatusSkill
} from "../src/hooks/codex-skills.js";

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  process.env.CODEX_HOME = originalCodexHome;
  vi.restoreAllMocks();
});

describe("Codex skills", () => {
  it("renders the specmarten-run skill with the end-to-end task workflow", () => {
    const skill = renderSpecMartenRunSkill();

    expect(codexSkillTemplates[SPECMARTEN_RUN_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-run");
    expect(skill).toContain("The current Codex session owns the full task");
    expect(skill).toContain("openspec/changes/<change-id>/");
    expect(skill).toContain("specmarten/ledger/changes/<change-id>/");
    expect(skill).toContain("specmarten/ledger/changes/archive/<date>-<change-id>/");
    expect(skill).toContain("There is no `specmarten archive` command");
    expect(skill).toContain("specmarten context --workflow maintain --json");
    expect(skill).toContain("specmarten state write-draft --kind maintain");
    expect(skill).toContain("`ledger`");
    expect(skill).toContain("specmarten validate --fix");
    expect(skill).toContain("specmarten validate --complete");
    expect(skill).toContain("openspec validate --all --strict");
    expect(skill).toContain("Do not commit, tag, publish, or push unless the user explicitly asks for that.");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("renders the specmarten-plan skill with the deterministic workflow", () => {
    const skill = renderSpecMartenPlanSkill();

    expect(codexSkillTemplates[SPECMARTEN_PLAN_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-plan");
    expect(skill).toContain("test -d specmarten && test -f .specmarten.json");
    expect(skill).toContain("specmarten context --workflow plan");
    expect(skill).toContain("specmarten state write-draft --kind plan");
    expect(skill).toContain("specmarten render");
    expect(skill).toContain("specmarten promote");
    expect(skill).toContain("choose `supersedes` by default");
    expect(skill).toContain("choose `parallel` only");
    expect(skill).not.toContain("/sm:plan");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("renders the specmarten-backfill skill with the deterministic workflow", () => {
    const skill = renderSpecMartenBackfillSkill();

    expect(codexSkillTemplates[SPECMARTEN_BACKFILL_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-backfill");
    expect(skill).toContain("test -d specmarten && test -f .specmarten.json");
    expect(skill).toContain("specmarten context --workflow backfill");
    expect(skill).toContain("specmarten state write-draft --kind backfill");
    expect(skill).toContain("specmarten render");
    expect(skill).toContain("specmarten promote");
    expect(skill).toContain("choose `supersedes` by default");
    expect(skill).toContain("choose `parallel` only");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("renders the specmarten-check skill with the deterministic workflow", () => {
    const skill = renderSpecMartenCheckSkill();

    expect(codexSkillTemplates[SPECMARTEN_CHECK_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-check");
    expect(skill).toContain("test -d specmarten && test -f .specmarten.json");
    expect(skill).toContain("specmarten context --workflow check --change");
    expect(skill).toContain("specmarten patrol report");
    expect(skill).toContain("Exit code 0 means PASS, 10 means WARN, and 2 means BLOCK");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("renders the specmarten-maintain skill with the deterministic workflow", () => {
    const skill = renderSpecMartenMaintainSkill();

    expect(codexSkillTemplates[SPECMARTEN_MAINTAIN_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-maintain");
    expect(skill).toContain("test -d specmarten && test -f .specmarten.json");
    expect(skill).toContain("specmarten context --workflow maintain");
    expect(skill).toContain("specmarten patrol report");
    expect(skill).toContain("specmarten state write-draft --kind maintain");
    expect(skill).toContain("specmarten render");
    expect(skill).toContain("Preserve existing `streams`");
    expect(skill).toContain("choose `supersedes` by default");
    expect(skill).toContain("`parallel` explicitly");
    expect(skill).toContain("No `specmarten promote` is needed for maintain.");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("renders the specmarten-status skill with the status-json workflow", () => {
    const skill = renderSpecMartenStatusSkill();

    expect(codexSkillTemplates[SPECMARTEN_STATUS_SKILL_NAME]).toBe(skill);
    expectGlobalContextCheckpoint(skill);
    expect(skill).toContain("name: specmarten-status");
    expect(skill).toContain("test -d specmarten && test -f .specmarten.json");
    expect(skill).toContain("specmarten status --summary-json");
    expect(skill).toContain("Do not run any other SpecMarten workflow unless the user asks for it.");
    expect(skill).toContain("Do not call `codex exec`, `claude -p`, `gemini -p`, or any other headless AI command.");
  });

  it("installs managed SpecMarten skills into CODEX_HOME/skills idempotently", async () => {
    const codexHome = await tempRoot();

    const first = await installCodexSkills({ env: { CODEX_HOME: codexHome } });
    const second = await installCodexSkills({ env: { CODEX_HOME: codexHome } });

    expect(first.skillsDir).toBe(join(codexHome, "skills"));
    expect(first.files).toHaveLength(6);
    expect(first.files).toEqual(expect.arrayContaining([expect.objectContaining({ action: "created" })]));
    expect(second.files).toHaveLength(6);
    expect(second.files).toEqual(expect.arrayContaining([expect.objectContaining({ action: "unchanged" })]));
    await expect(readFile(skillPath(codexHome, SPECMARTEN_RUN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_RUN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_PLAN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_PLAN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_BACKFILL_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_BACKFILL_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_CHECK_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_CHECK_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_MAINTAIN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_MAINTAIN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_STATUS_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_STATUS_SKILL_NAME]
    );
  });

  it("preserves changed skill content during init-style install and update overwrites it", async () => {
    const codexHome = await tempRoot();
    await installCodexSkills({ env: { CODEX_HOME: codexHome } });
    await writeFile(skillPath(codexHome, SPECMARTEN_PLAN_SKILL_NAME), "user local edit\n", "utf8");

    const preserved = await installCodexSkills({ env: { CODEX_HOME: codexHome }, overwrite: false });
    process.env.CODEX_HOME = codexHome;
    const updated = await runUpdate();

    expect(preserved.files).toEqual(expect.arrayContaining([expect.objectContaining({ action: "preserved" })]));
    expect(updated.files).toEqual(expect.arrayContaining([expect.objectContaining({ action: "updated" })]));
    await expect(readFile(skillPath(codexHome, SPECMARTEN_PLAN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_PLAN_SKILL_NAME]
    );
  });

  it("exposes update as a deterministic command", async () => {
    const codexHome = await tempRoot();
    process.env.CODEX_HOME = codexHome;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program);

    await program.parseAsync(["node", "specmarten", "update"], { from: "node" });

    expect(log.mock.calls.flat().join("\n")).toContain("updated Codex skills");
    await expect(readFile(skillPath(codexHome, SPECMARTEN_RUN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_RUN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_PLAN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_PLAN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_BACKFILL_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_BACKFILL_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_CHECK_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_CHECK_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_MAINTAIN_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_MAINTAIN_SKILL_NAME]
    );
    await expect(readFile(skillPath(codexHome, SPECMARTEN_STATUS_SKILL_NAME), "utf8")).resolves.toBe(
      codexSkillTemplates[SPECMARTEN_STATUS_SKILL_NAME]
    );
  });

  it("does not mention global Codex config writes", async () => {
    const sources = await Promise.all(
      ["src/hooks/codex-skills.ts", "src/commands/update.ts"].map((file) => readFile(join(process.cwd(), file), "utf8"))
    );

    expect(sources.join("\n")).not.toMatch(/config\.toml|notify/);
  });

  it("keeps user docs on the skill-based Codex entrypoint", async () => {
    const docs = await Promise.all(
      ["README.md", "src/hooks/codex-skills.ts"].map((file) =>
        readFile(join(process.cwd(), file), "utf8")
      )
    );
    const text = docs.join("\n");

    expect(text).toContain("$specmarten-run");
    expect(text).toContain("$specmarten-plan");
    expect(text).not.toContain("/sm:plan");
    expect(text).not.toContain("prompts/sm-plan");
  });
});

function skillPath(codexHome: string, skillName: string): string {
  return join(codexHome, "skills", skillName, "SKILL.md");
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-codex-skills-test-"));
}

function expectGlobalContextCheckpoint(skill: string): void {
  expect(skill).toContain("specmarten status --summary-json");
  expect(skill).toContain("remaining tasks");
  expect(skill).toContain("read-only");
}
