import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { claudeTemplateFiles } from "../src/templates/index.js";

describe("Claude support documentation", () => {
  it("documents Claude Code-only support without a Claude Desktop fallback mode", async () => {
    const readme = await readFile("README.md", "utf8");
    const generatedClaudeDocs = Object.values(claudeTemplateFiles).join("\n");
    const combined = [readme, generatedClaudeDocs].join("\n");

    expect(readme).toContain("Claude support is Claude Code-only");
    expect(readme).toContain("Claude Desktop is not a supported integration target");
    expect(combined).toContain("Claude Code");
    expect(combined).toContain("SpecMarten Plan");
  });
});
