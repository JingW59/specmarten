import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { runCloseout } from "../src/core/closeout/closeout.js";
import { registerDashboardCommand } from "../src/commands/dashboard.js";
import { registerValidateCommand } from "../src/commands/validate.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig, readConfig } from "../src/config/config.js";
import { refreshBaseline } from "../src/core/baseline.js";
import { runCheck } from "../src/core/check/check.js";
import { isAllowedPreferenceWriteRequest, runDashboard } from "../src/core/dashboard/dashboard.js";
import { runMaintain } from "../src/core/maintenance/maintain.js";
import { writeMaintainMarker } from "../src/core/maintenance/marker.js";
import { runReconcile } from "../src/core/reconcile/reconcile.js";
import { renderViews } from "../src/core/renderers/index.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { runValidate } from "../src/core/validate/validate.js";
import { writeJson, writeText } from "../src/util/fs.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("P1 commands", () => {
  it("builds a self-contained dashboard from state", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const summary = await runDashboard({ root, config: defaultConfig(), buildOnly: true });
    const html = await readFile(summary.dashboardPath, "utf8");

    expect(summary.opened).toBe(false);
    expect(html).toContain("<style>");
    expect(html).toContain("sr-only");
    expect(html).toContain("type=\"application/json\"");
    // The redesigned dashboard uses glyph statuses, theming, and stream structure.
    expect(html).toContain("✓");
    expect(html).toContain("◐");
    expect(html).toContain("data-theme");
    expect(html).toContain("specmarten-theme");
    expect(html).toContain("data-specmarten-dashboard");
  });

  it("advertises dashboard serve mode without promoting legacy build-only mode", () => {
    let help = "";
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
      writeErr: (chunk) => {
        help += chunk;
      }
    });
    registerDashboardCommand(program);

    expect(() => program.parse(["node", "specmarten", "dashboard", "--help"], { from: "node" })).toThrow();
    expect(help).not.toContain("--build");
    expect(help).toContain("--serve");
    expect(help).toContain("--port");
  });

  it("validates generated views and flags stale roadmap output", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));

    const ok = await runValidate({ root, backend, config: defaultConfig() });
    await writeText(join(root, "specmarten", "roadmap.md"), "# stale\n");
    const stale = await runValidate({ root, backend, config: defaultConfig() });

    expect(ok.issues.some((issue) => issue.level === "error")).toBe(false);
    expect(stale.issues.some((issue) => issue.code === "roadmap-stale")).toBe(true);
    expect(stale.issues.find((issue) => issue.code === "roadmap-stale")?.fixCommand).toBe("specmarten validate --fix");
  });

  it("keeps regular validation permissive but blocks completion claims with incomplete active checklists", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeFile(
      join(root, "openspec", "changes", "do-status", "tasks.md"),
      "# Tasks\n\n- [x] Implement status\n- [ ] Mark validation complete\n",
      "utf8"
    );
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));

    const regular = await runValidate({ root, backend, config: defaultConfig() });
    const complete = await runValidate({ root, backend, config: defaultConfig(), requireComplete: true });

    expect(regular.issues.some((issue) => issue.code === "openspec-active-incomplete")).toBe(false);
    expect(complete.ok).toBe(false);
    expect(complete.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "openspec-active-incomplete",
          message: expect.stringContaining("1/2 tasks complete")
        })
      ])
    );
  });

  it("blocks completion claims when state is not reconciled with complete active checklists", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeFile(
      join(root, "openspec", "changes", "do-status", "tasks.md"),
      "# Tasks\n\n- [x] Implement status\n- [x] Mark validation complete\n",
      "utf8"
    );
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));

    const complete = await runValidate({ root, backend, config: defaultConfig(), requireComplete: true });

    expect(complete.ok).toBe(false);
    expect(complete.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "specmarten-state-unreconciled",
          fixCommand: "specmarten maintain"
        })
      ])
    );

    await runReconcile({ root, backend });

    const ready = await runValidate({ root, backend, config: defaultConfig(), requireComplete: true });

    expect(ready.issues.some((issue) => issue.code === "openspec-active-incomplete")).toBe(false);
    expect(ready.issues.some((issue) => issue.code === "specmarten-state-unreconciled")).toBe(false);
  });

  it("suggests bootstrap when the OpenSpec backend is missing", async () => {
    const root = await tempRoot();
    await writeJson(join(root, ".specmarten.json"), defaultConfig());
    await mkdir(join(root, "specmarten", "reports"), { recursive: true });
    await writeState(root, createInitialState());

    const summary = await runValidate({ root, backend: new OpenSpecBackend(root), config: defaultConfig() });

    expect(summary.issues.find((issue) => issue.code === "backend-missing")?.fixCommand).toBe(
      "specmarten init --bootstrap"
    );
  });

  it("explains missing or invalid local project state without raw ENOENT or JSON errors", async () => {
    const missingRoot = await tempRoot();
    await expect(readConfig(missingRoot)).rejects.toThrow("specmarten init");
    await expect(readState(missingRoot)).rejects.toThrow("specmarten/state.json");

    const brokenRoot = await tempRoot();
    await mkdir(join(brokenRoot, "specmarten"), { recursive: true });
    await writeFile(join(brokenRoot, ".specmarten.json"), "{", "utf8");
    await writeFile(join(brokenRoot, "specmarten", "state.json"), "{", "utf8");

    await expect(readConfig(brokenRoot)).rejects.toThrow(".specmarten.json");
    await expect(readState(brokenRoot)).rejects.toThrow("specmarten/state.json");
  });

  it("requires local same-origin dashboard preference writes", () => {
    expect(
      isAllowedPreferenceWriteRequest({
        headers: {
          host: "127.0.0.1:4321",
          origin: "http://127.0.0.1:4321",
          "x-specmarten-dashboard": "1"
        }
      })
    ).toBe(true);
    expect(
      isAllowedPreferenceWriteRequest({
        headers: {
          host: "127.0.0.1:4321",
          origin: "https://evil.example",
          "x-specmarten-dashboard": "1"
        }
      })
    ).toBe(false);
    expect(
      isAllowedPreferenceWriteRequest({
        headers: {
          host: "127.0.0.1:4321",
          origin: "http://127.0.0.1:9999",
          "x-specmarten-dashboard": "1"
        }
      })
    ).toBe(false);
    expect(
      isAllowedPreferenceWriteRequest({
        headers: {
          host: "127.0.0.1:4321",
          origin: "http://127.0.0.1:4321"
        }
      })
    ).toBe(false);
  });

  it("serves dashboard routes and protects writable preferences over HTTP", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const summary = await runDashboard({ root, config: defaultConfig(), serve: true, port: 0 });
    const url = summary.url ?? "";
    const origin = new URL(url).origin;
    const preferencesUrl = new URL("/api/preferences/language", url);

    try {
      const home = await fetch(url);
      expect(home.status).toBe(200);
      await expect(home.text()).resolves.toContain("data-writable-preferences=\"true\"");

      const dashboard = await fetch(new URL("/dashboard.html", url));
      expect(dashboard.status).toBe(200);
      await expect(dashboard.text()).resolves.toContain("data-writable-preferences=\"true\"");

      const missingHeader = await fetch(preferencesUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentLanguage: "zh" })
      });
      expect(missingHeader.status).toBe(403);

      const crossOrigin = await fetch(preferencesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "x-specmarten-dashboard": "1"
        },
        body: JSON.stringify({ contentLanguage: "zh" })
      });
      expect(crossOrigin.status).toBe(403);

      const invalidLanguage = await fetch(preferencesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-specmarten-dashboard": "1"
        },
        body: JSON.stringify({ contentLanguage: "xx" })
      });
      expect(invalidLanguage.status).toBe(400);

      const malformedJson = await fetch(preferencesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-specmarten-dashboard": "1"
        },
        body: "{"
      });
      expect(malformedJson.status).toBe(400);

      const oversizedBody = await fetch(preferencesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-specmarten-dashboard": "1"
        },
        body: "x".repeat(1025)
      });
      expect(oversizedBody.status).toBe(400);

      const accepted = await fetch(preferencesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-specmarten-dashboard": "1"
        },
        body: JSON.stringify({ contentLanguage: "zh" })
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ contentLanguage: "zh" });
      expect((await readConfig(root)).language.content).toBe("zh");

      const missing = await fetch(new URL("/nonexistent", url));
      expect(missing.status).toBe(404);
    } finally {
      await summary.close?.();
    }
  }, 15_000);

  it("fixes stale generated views during validate --fix", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await renderViews(root, await readState(root));
    await writeText(join(root, "specmarten", "roadmap.md"), "# stale\n");

    const output = await runValidateCommand(root, ["validate", "--fix", "--json"]);
    const payload = JSON.parse(output);
    const summary = await runValidate({ root, backend, config: defaultConfig() });

    expect(payload.viewsFixed).toBe(true);
    expect(payload.stateFixed).toBe(false);
    expect(payload.remainingIssues).toEqual(payload.issues);
    expect(payload.recommendedCommand).toBeNull();
    expect(summary.issues.some((issue) => issue.code === "roadmap-stale")).toBe(false);
    expect(summary.issues.some((issue) => issue.code === "dashboard-stale")).toBe(false);
  });

  it("refreshes baseline hash, snapshot, state, and views", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    const first = await refreshBaseline({ root, backend });
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nUpdated\n", "utf8");

    const drift = await runValidate({ root, backend, config: defaultConfig() });
    const refreshed = await refreshBaseline({ root, backend });
    const state = await readState(root);
    const after = await runValidate({ root, backend, config: defaultConfig() });

    expect(first.specsHash).not.toBe(refreshed.specsHash);
    expect(refreshed.copiedFiles).toBe(1);
    expect(state.baseline?.specsHash).toBe(refreshed.specsHash);
    await expect(readFile(join(root, "specmarten", "baseline", "baseline.json"), "utf8")).resolves.toContain(
      `"copiedFiles": 1`
    );
    await expect(readFile(join(root, "specmarten", "baseline", "specs-snapshot", "status", "spec.md"), "utf8"))
      .resolves.toContain("Updated");
    expect(drift.issues.some((issue) => issue.code === "baseline-drift")).toBe(true);
    expect(after.issues.some((issue) => issue.code === "baseline-drift")).toBe(false);
    expect(after.issues.some((issue) => issue.code === "roadmap-stale" || issue.code === "dashboard-stale")).toBe(false);
  });

  it("warns when an accepted OpenSpec spec still has Purpose TBD", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nTBD\n", "utf8");

    const summary = await runValidate({ root, backend: new OpenSpecBackend(root), config: defaultConfig() });

    const issue = summary.issues.find((item) => item.code === "purpose-tbd");
    expect(issue?.message).toContain("openspec/specs/status/spec.md");
    expect(issue?.message).toContain('Suggested Purpose: "Define Render status behavior."');
    expect(issue?.fixCommand).toContain("openspec/specs/status/spec.md");
  });

  it("blocks baseline refresh when Purpose TBD remains and gives a concrete suggestion", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nTBD\n", "utf8");

    await expect(refreshBaseline({ root, backend: new OpenSpecBackend(root) })).rejects.toThrow(
      'Suggested Purpose: "Define Render status behavior."'
    );
  });

  it("warns when an active OpenSpec change is not linked to any roadmap task", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeUnlinkedProjectState(root);

    const summary = await runValidate({ root, backend: new OpenSpecBackend(root), config: defaultConfig() });

    expect(summary.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "openspec-active-unlinked",
          message: expect.stringContaining("do-status"),
          fixCommand: "$specmarten-maintain"
        })
      ])
    );
  });

  it("runs maintain reconciliation without patrol when only known links changed", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");

    const summary = await runMaintain({ root, backend, config: defaultConfig(), agent: new ThrowingAgent() });
    const state = await readState(root);

    expect(summary.agentCalled).toBe(false);
    expect(summary.report).toBeUndefined();
    expect(collectPhases(state)[0]?.tasks[1]?.status).toBe("done");
  });

  it("closes out archive drift with reconcile, render, baseline refresh, and validation", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    await refreshBaseline({ root, backend });
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");
    await writeFile(
      join(root, "openspec", "specs", "status", "spec.md"),
      "# Status Spec\n\n## Purpose\nDefine status behavior.\n",
      "utf8"
    );
    await writeText(join(root, "specmarten", "roadmap.md"), "# stale\n");

    const summary = await runCloseout({ root, backend, config: defaultConfig() });
    const state = await readState(root);

    expect(summary.exitCode).toBe(0);
    expect(summary.baseline?.copiedFiles).toBe(1);
    expect(summary.blockingIssues).toEqual([]);
    expect(collectPhases(state)[0]?.tasks[1]?.status).toBe("done");
    await expect(readFile(join(root, "specmarten", "baseline", "specs-snapshot", "status", "spec.md"), "utf8"))
      .resolves.toContain("Define status behavior.");
    expect(summary.validation.issues.some((issue) => issue.code === "baseline-drift")).toBe(false);
    expect(summary.validation.issues.some((issue) => issue.code === "roadmap-stale")).toBe(false);
  });

  it("keeps Purpose TBD as a blocking closeout issue", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);
    const originalBaseline = await refreshBaseline({ root, backend });
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");
    await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n\n## Purpose\nTBD\n", "utf8");

    const summary = await runCloseout({ root, backend, config: defaultConfig() });
    const state = await readState(root);

    expect(summary.exitCode).toBe(1);
    expect(summary.baseline).toBeUndefined();
    expect(summary.blockingIssues.map((issue) => issue.code)).toContain("purpose-tbd");
    expect(state.baseline?.specsHash).toBe(originalBaseline.specsHash);
    await expect(readFile(join(root, "specmarten", "baseline", "specs-snapshot", "status", "spec.md"), "utf8"))
      .resolves.not.toContain("TBD");
  });

  it("blocks closeout when an archived change still is not linked to roadmap state", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    await writeUnlinkedProjectState(root);
    const backend = new OpenSpecBackend(root);
    const originalBaseline = await refreshBaseline({ root, backend });
    await writeMaintainMarker(root, await backend.getCurrentMarker());
    await archiveChange(root, "do-status");
    await writeFile(
      join(root, "openspec", "specs", "status", "spec.md"),
      "# Status Spec\n\n## Purpose\nDefine status behavior.\n",
      "utf8"
    );

    const summary = await runCloseout({ root, backend, config: defaultConfig() });
    const state = await readState(root);

    expect(summary.exitCode).toBe(1);
    expect(summary.baseline).toBeUndefined();
    expect(summary.blockingIssues.map((issue) => issue.code)).toContain("openspec-archived-unlinked");
    expect(state.unlinkedChanges).toEqual(["do-status"]);
    expect(state.baseline?.specsHash).toBe(originalBaseline.specsHash);
  });

  it("runs independent check, writes report, updates lastPatrol, and maps WARN to exit 10", async () => {
    const root = await tempRoot();
    await createProject(root, "do-status");
    const backend = new OpenSpecBackend(root);

    const summary = await runCheck({
      root,
      backend,
      config: defaultConfig(),
      agent: new WarnCheckAgent(),
      change: "do-status"
    });
    const state = await readState(root);

    expect(summary.verdict).toBe("WARN");
    expect(summary.exitCode).toBe(10);
    expect(summary.report).toMatch(/^reports\//);
    expect(state.lastPatrol?.verdict).toBe("WARN");
    await expect(readFile(join(root, "specmarten", summary.report), "utf8")).resolves.toContain("VERDICT: WARN");
  });
});

class ThrowingAgent implements AgentRunner {
  name = "codex" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    throw new Error("agent should not be called");
  }
}

class WarnCheckAgent implements AgentRunner {
  name = "codex" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    return JSON.stringify({
      patrol: {
        change: "do-status",
        report: `# Overseer 巡检报告 · do-status
## 概要
Manual check found a warning.
## 发现
| # | 维度 | 严重度 | 位置(文件:符号) | 说明 | 建议 |
| 1 | 范围核对 | WARN | src/cli.ts:status | Needs review | Clarify scope |
## 回写建议
- 无

VERDICT: WARN
`
      },
      notes: []
    });
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-p1-test-"));
}

async function createProject(root: string, changeId: string): Promise<void> {
  await writeJson(join(root, ".specmarten.json"), defaultConfig());
  await mkdir(join(root, "specmarten", "reports"), { recursive: true });
  await mkdir(join(root, "openspec", "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", changeId, "specs", "status"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive", "2026-06-01-bootstrap"), { recursive: true });
  await writeFile(join(root, "openspec", "specs", "status", "spec.md"), "# Status Spec\n", "utf8");
  await writeFile(join(root, "openspec", "changes", changeId, "proposal.md"), "# Render status\n", "utf8");
  await writeFile(join(root, "openspec", "changes", changeId, "specs", "status", "spec.md"), "## ADDED Requirements\n", "utf8");
  await writeFile(
    join(root, "openspec", "changes", "archive", "2026-06-01-bootstrap", "proposal.md"),
    "# Bootstrap\n",
    "utf8"
  );
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI"
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [
          { id: "p1.1", title: "Bootstrap", status: "done", changes: ["2026-06-01-bootstrap"] },
          { id: "p1.2", title: "Render status", status: "in-progress", changes: [changeId] }
        ]
      }
    ]));
}

async function writeUnlinkedProjectState(root: string): Promise<void> {
  await writeState(root, singleStreamState({
    ...createInitialState(),
    mission: "Status CLI",
  }, [
      {
        id: "p1",
        title: "MVP",
        status: "in-progress",
        tasks: [
          { id: "p1.1", title: "Bootstrap", status: "done", changes: ["2026-06-01-bootstrap"] },
          { id: "p1.2", title: "Render status", status: "todo", changes: [] }
        ]
      }
    ]));
}

async function archiveChange(root: string, id: string): Promise<void> {
  await rename(join(root, "openspec", "changes", id), join(root, "openspec", "changes", "archive", id));
}

async function runValidateCommand(root: string, args: string[]): Promise<string> {
  let stdout = "";
  process.chdir(root);
  const program = new Command();
  program.exitOverride();
  registerValidateCommand(program);
  const log = vi.spyOn(console, "log").mockImplementation((...chunks: unknown[]) => {
    stdout += `${chunks.join(" ")}\n`;
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });

  try {
    await program.parseAsync(["node", "specmarten", ...args], { from: "node" });
  } finally {
    log.mockRestore();
    write.mockRestore();
  }

  return stdout;
}
