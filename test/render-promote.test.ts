import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPromoteCommand } from "../src/commands/promote.js";
import { registerRenderCommand } from "../src/commands/render.js";
import { runPromote } from "../src/core/promote/promote.js";
import { runRender } from "../src/core/render/render.js";
import { singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("render and promote", () => {
  it("renders roadmap.md and dashboard.html from the current state", async () => {
    const root = await createDraftProject();
    await writeFile(join(root, "specmarten", "roadmap.md"), "# stale\n", "utf8");
    await writeFile(join(root, "specmarten", "dashboard.html"), "stale", "utf8");

    const summary = await runRender({ root });

    expect(summary.roadmapPath).toBe(join(root, "specmarten", "roadmap.md"));
    await expect(readFile(summary.roadmapPath, "utf8")).resolves.toContain("Client-first MVP");
    await expect(readFile(summary.roadmapPath, "utf8")).resolves.toContain("Implement render command");
    await expect(readFile(summary.dashboardPath, "utf8")).resolves.toContain("SpecMarten · Project Status Dashboard");
    await expect(readFile(summary.dashboardPath, "utf8")).resolves.toContain("data-specmarten-dashboard");
    await expect(readFile(summary.dashboardPath, "utf8")).resolves.toContain("Client-first MVP");
  });

  it("promotes a draft state and regenerates generated views", async () => {
    const root = await createDraftProject();

    const summary = await runPromote({ root });
    const state = await readState(root);

    expect(summary.phases).toBe(1);
    expect(summary.tasks).toBe(1);
    expect(state.draft).toBeUndefined();
    expect(state.draftKind).toBeUndefined();
    await expect(readFile(join(root, "specmarten", "roadmap.md"), "utf8")).resolves.not.toContain(
      "AI-GENERATED DRAFT"
    );
    await expect(readFile(join(root, "specmarten", "dashboard.html"), "utf8")).resolves.toContain(
      "Implement render command"
    );
  });

  it("exposes deterministic render and promote command entries", async () => {
    const root = await createDraftProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(root, registerRenderCommand, "render");
    await runCommand(root, registerPromoteCommand, "promote");

    expect(log.mock.calls.flat().join("\n")).toContain("rendered generated views");
    expect(log.mock.calls.flat().join("\n")).toContain("promoted draft state");
    expect((await readState(root)).draft).toBeUndefined();
  });
});

async function runCommand(
  root: string,
  register: (program: Command) => void,
  command: "render" | "promote"
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  process.chdir(root);
  await program.parseAsync(["node", "specmarten", command], { from: "node" });
}

async function createDraftProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-render-test-"));
  await mkdir(join(root, "specmarten"), { recursive: true });
  await writeState(root, singleStreamState({
    ...createInitialState(),
    draft: true,
    draftKind: "plan",
    mission: "Client-first MVP",
  }, [
      {
        id: "p1",
        title: "PR-1",
        status: "planned",
        tasks: [{ id: "p1.1", title: "Implement render command", status: "todo", changes: [] }]
      }
    ]));
  return root;
}
