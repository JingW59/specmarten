import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShellAgentRunner, createPreferredAgentRunner } from "../src/adapters/agent/shell-runner.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.SPECMARTEN_FAKE_AGENT_LOG;
  delete process.env.SPECMARTEN_FAKE_AGENT_PROMPT;
});

describe("ShellAgentRunner", () => {
  it("uses codex exec with stdin and reads the clean final-message file", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const argsLog = join(root, "args.log");
    const promptLog = join(root, "prompt.log");
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh
printf '%s\\n' "$*" > "$SPECMARTEN_FAKE_AGENT_LOG"
cat > "$SPECMARTEN_FAKE_AGENT_PROMPT"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
  fi
  prev="$arg"
done
printf '{"ok":true,"source":"file"}\\n' > "$out"
printf 'noisy stdout {"ok":false}\\n'
`,
      "utf8"
    );
    await chmod(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SPECMARTEN_FAKE_AGENT_LOG = argsLog;
    process.env.SPECMARTEN_FAKE_AGENT_PROMPT = promptLog;

    const output = await new ShellAgentRunner("codex").run("hello from stdin", { cwd: root });

    expect(output.trim()).toBe('{"ok":true,"source":"file"}');
    await expect(readFile(argsLog, "utf8")).resolves.toContain("exec --skip-git-repo-check --ephemeral");
    await expect(readFile(argsLog, "utf8")).resolves.toContain("--output-last-message");
    await expect(readFile(promptLog, "utf8")).resolves.toBe("hello from stdin");
  });

  it("uses gemini headless mode instead of launching interactive mode", async () => {
    const root = await tempRoot();
    const bin = await tempRoot();
    const argsLog = join(root, "args.log");
    const promptLog = join(root, "prompt.log");
    await writeFile(
      join(bin, "gemini"),
      `#!/bin/sh
printf '%s\\n' "$*" > "$SPECMARTEN_FAKE_AGENT_LOG"
cat > "$SPECMARTEN_FAKE_AGENT_PROMPT"
printf '{"ok":true}\\n'
`,
      "utf8"
    );
    await chmod(join(bin, "gemini"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SPECMARTEN_FAKE_AGENT_LOG = argsLog;
    process.env.SPECMARTEN_FAKE_AGENT_PROMPT = promptLog;

    const output = await new ShellAgentRunner("gemini").run("prompt via stdin", { cwd: root });

    expect(output.trim()).toBe('{"ok":true}');
    await expect(readFile(argsLog, "utf8")).resolves.toContain("-p");
    await expect(readFile(promptLog, "utf8")).resolves.toBe("prompt via stdin");
  });

  it("prefers codex before claude and gemini", async () => {
    const bin = await tempRoot();
    for (const name of ["codex", "claude", "gemini"]) {
      await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    await expect(createPreferredAgentRunner(["codex", "claude", "gemini"])).resolves.toMatchObject({
      name: "codex"
    });
  });
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-test-"));
}
