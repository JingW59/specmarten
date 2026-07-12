import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { runPlan } from "../src/core/planner/plan.js";
import { collectPhases, singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { pathExists, writeJson } from "../src/util/fs.js";
import { defaultConfig } from "../src/config/config.js";

describe("plan", () => {
  it("asks the AI planner for a draft roadmap and renders generated views", async () => {
    const root = await tempRoot();
    await createSpecMartenProject(root);
    const agent = new FakePlannerAgent();

    const summary = await runPlan({
      root,
      requirement: "Build a CLI status snapshot",
      agent
    });
    const state = await readState(root);

    expect(summary.promoted).toBe(false);
    expect(summary.phases).toBe(1);
    expect(summary.tasks).toBe(2);
    expect(summary.questions).toEqual(["Which status fields are user-facing?"]);
    expect(state.draft).toBe(true);
    expect(state.draftKind).toBe("plan");
    expect(collectPhases(state)[0]?.tasks[0]).toMatchObject({
      title: "Define status output",
      status: "todo",
      changes: []
    });
    expect(agent.lastPrompt).toContain("[TODO: user mission stays here]");
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.toContain("AI-GENERATED DRAFT");
    await expect(readFile(join(root, "specmarten", "plan-report.md"), "utf8")).resolves.toContain(
      "Which status fields"
    );
  });

  it("promotes a reviewed draft without calling an agent", async () => {
    const root = await tempRoot();
    await createSpecMartenProject(root);
    await writeState(root, singleStreamState({
      ...createInitialState(),
      draft: true,
    }, [
        {
          id: "p1",
          title: "MVP",
          status: "planned",
          tasks: [{ id: "p1.1", title: "Define status output", status: "todo", changes: [] }]
        }
      ]));

    const summary = await runPlan({ root, promote: true, agent: new ThrowingAgent() });
    const state = await readState(root);

    expect(summary.promoted).toBe(true);
    expect(state.draft).toBeUndefined();
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.not.toContain(
      "AUTO-BACKFILLED DRAFT"
    );
  });

  it("fails closed when no planner agent is available", async () => {
    const root = await tempRoot();
    await createSpecMartenProject(root);

    await expect(runPlan({ root, requirement: "Build status" })).rejects.toThrow("Plan requires an available");
  });
});

class FakePlannerAgent implements AgentRunner {
  name = "codex" as const;
  lastPrompt = "";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return JSON.stringify({
      mission: "Status snapshot CLI",
      phases: [
        {
          id: "p1",
          title: "Status MVP",
          status: "planned",
          tasks: [
            { id: "p1.1", title: "Define status output", status: "todo", changes: [] },
            { id: "p1.2", title: "Render status command", status: "todo", changes: [] }
          ]
        }
      ],
      questions: ["Which status fields are user-facing?"],
      notes: ["Draft only"]
    });
  }
}

class ThrowingAgent implements AgentRunner {
  name = "codex" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    throw new Error("agent should not be called");
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-plan-test-"));
}

async function createSpecMartenProject(root: string): Promise<void> {
  await mkdir(join(root, "specmarten", "standards"), { recursive: true });
  await writeJson(join(root, ".specmarten.json"), defaultConfig("openspec"));
  await writeState(root, createInitialState());
  await writeFile(join(root, "specmarten", "mission.md"), "# Mission\n\n[TODO: user mission stays here]\n", "utf8");
  await writeFile(join(root, "specmarten", "tech-stack.md"), "# Tech Stack\n\n[TODO: user stack]\n", "utf8");
  await writeFile(join(root, "specmarten", "standards", "hard-rules.md"), "# Hard Rules\n\n- [HARD] Keep specs honest.\n", "utf8");
  expect(await pathExists(join(root, "specmarten", "state.json"))).toBe(true);
}
