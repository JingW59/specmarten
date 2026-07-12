import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/adapters/agent/types.js";
import { OpenSpecBackend } from "../src/adapters/spec-backend/openspec.js";
import { defaultConfig } from "../src/config/config.js";
import { runCheck } from "../src/core/check/check.js";
import { detectHardContractDrift } from "../src/core/overseer/hard-contract.js";
import { singleStreamState } from "../src/core/state/schema.js";
import { createInitialState, readState, writeState } from "../src/core/state/store.js";
import { writeText } from "../src/util/fs.js";

describe("hard-contract drift", () => {
  it("detects removed exported symbols and route endpoints from unified diff text", () => {
    const drift = detectHardContractDrift(`diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
-export function getUser(id: string) {
-router.delete("/users/:id", deleteUser);
+const internal = true;
`);

    expect(drift?.verdict).toBe("BLOCK");
    expect(drift?.findings).toEqual([
      {
        kind: "removed-export",
        location: "src/api.ts:getUser",
        evidence: "export function getUser(id: string) {"
      },
      {
        kind: "removed-route",
        location: "src/api.ts:DELETE /users/:id",
        evidence: 'router.delete("/users/:id", deleteUser);'
      }
    ]);
    expect(drift?.report).toContain("VERDICT: BLOCK");
  });

  it("blocks check deterministically before calling an agent for removed public contracts", async () => {
    const root = await createCheckProject();
    const agent = new ThrowingAgent();

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      agent,
      change: "remove-api",
      diff: `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
-export class PublicApi {}
`
    });
    const state = await readState(root);
    const report = await readFile(join(root, "specmarten", summary.report), "utf8");

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.exitCode).toBe(2);
    expect(agent.called).toBe(false);
    expect(state.lastPatrol?.verdict).toBe("BLOCK");
    expect(report).toContain("agent: deterministic-hard-contract");
    expect(report).toContain("PublicApi");
  });

  it("ignores non-runtime source removals", () => {
    expect(
      detectHardContractDrift(`diff --git a/docs/api.md b/docs/api.md
--- a/docs/api.md
+++ b/docs/api.md
-export function documentedExample() {}
`)
    ).toBeNull();
    expect(
      detectHardContractDrift(`diff --git a/test/routes.test.ts b/test/routes.test.ts
--- a/test/routes.test.ts
+++ b/test/routes.test.ts
-app.get("/fixture", handler);
`)
    ).toBeNull();
  });

  it("ignores added and unchanged public signatures", () => {
    expect(
      detectHardContractDrift(`diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
 export function keepUser() {}
+export function addUser() {}
`)
    ).toBeNull();
  });

  it("does not require an agent when a hard-contract removal is deterministic", async () => {
    const root = await createCheckProject();

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      change: "remove-api",
      diff: `diff --git a/src/routes.ts b/src/routes.ts
--- a/src/routes.ts
+++ b/src/routes.ts
-app.get("/v1/users", listUsers);
`
    });

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.exitCode).toBe(2);
  });

  it("keeps non-hard diffs on the model-backed check path", async () => {
    const root = await createCheckProject();
    const agent = new VerdictAgent("WARN");

    const summary = await runCheck({
      root,
      backend: new OpenSpecBackend(root),
      config: defaultConfig("openspec"),
      agent,
      change: "remove-api",
      diff: `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
-old wording
+new wording
`
    });

    expect(agent.called).toBe(true);
    expect(summary.verdict).toBe("WARN");
    expect(summary.exitCode).toBe(10);
  });
});

class ThrowingAgent implements AgentRunner {
  name = "codex" as const;
  called = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    this.called = true;
    throw new Error("agent should not be called");
  }
}

class VerdictAgent implements AgentRunner {
  name = "codex" as const;
  called = false;

  constructor(private readonly verdict: "PASS" | "WARN" | "BLOCK") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(): Promise<string> {
    this.called = true;
    return JSON.stringify({
      patrol: {
        change: "remove-api",
        report: `# Patrol\n\nVERDICT: ${this.verdict}\n`
      },
      notes: []
    });
  }
}

async function createCheckProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specmarten-hard-contract-test-"));
  await mkdir(join(root, "openspec", "specs", "api"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "remove-api", "specs", "api"), { recursive: true });
  await writeText(join(root, "openspec", "specs", "api", "spec.md"), "# API Spec\n");
  await writeText(join(root, "openspec", "changes", "remove-api", "proposal.md"), "# Remove API\n");
  await writeText(join(root, "openspec", "changes", "remove-api", "specs", "api", "spec.md"), "## MODIFIED Requirements\n");
  await writeState(
    root,
    singleStreamState(
      {
        ...createInitialState(),
        mission: "Protect public contracts"
      },
      [
        {
          id: "p1",
          title: "API",
          status: "in-progress",
          tasks: [{ id: "p1.1", title: "Review API drift", status: "in-progress", changes: ["remove-api"] }]
        }
      ]
    )
  );
  return root;
}
