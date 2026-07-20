import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  globalConfigPath,
  readConfig,
  writeContentLanguage
} from "../src/config/config.js";
import { readJson, writeJson, writeText } from "../src/util/fs.js";

describe("configuration layers", () => {
  it("resolves the global path from explicit, XDG, Windows, and home locations", () => {
    expect(globalConfigPath({ env: { SPECMARTEN_CONFIG: "/custom/specmarten.json" } })).toBe(
      "/custom/specmarten.json"
    );
    expect(globalConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/user" })).toBe(
      "/xdg/specmarten/config.json"
    );
    expect(globalConfigPath({ env: { APPDATA: "C:\\Users\\me\\AppData" }, platform: "win32", home: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me\\AppData/specmarten/config.json"
    );
    expect(globalConfigPath({ env: {}, platform: "darwin", home: "/home/user" })).toBe(
      "/home/user/.config/specmarten/config.json"
    );
  });

  it("uses built-in defaults when no global configuration exists", async () => {
    const root = await tempRoot();
    await writeJson(join(root, ".specmarten.json"), { specBackend: "native" });

    await expect(readConfig(root, { globalPath: join(root, "missing.json") })).resolves.toEqual(defaultConfig());
  });

  it("merges defaults, global preferences, and project overrides by field", async () => {
    const root = await tempRoot();
    const globalPath = join(root, "user", "config.json");
    await writeJson(globalPath, {
      agent: { prefer: ["claude"] },
      dashboard: { autoOpen: true },
      language: { content: "zh" },
      overseer: {
        blocking: "pre-archive-block",
        sensitivePaths: ["global/**"]
      }
    });
    await writeJson(join(root, ".specmarten.json"), {
      specBackend: "openspec",
      dashboard: {},
      overseer: { blocking: "advisory" }
    });

    const config = await readConfig(root, { globalPath });

    expect(config.specBackend).toBe("openspec");
    expect(config.agent.prefer).toEqual(["claude"]);
    expect(config.dashboard.autoOpen).toBe(true);
    expect(config.language.content).toBe("zh");
    expect(config.overseer.blocking).toBe("advisory");
    expect(config.overseer.sensitivePaths).toEqual(["global/**"]);
    expect(config.overseer.signaturePattern).toBe(defaultConfig().overseer.signaturePattern);
  });

  it("rejects project-only or unknown fields in global configuration", async () => {
    const root = await tempRoot();
    const globalPath = join(root, "config.json");
    await writeJson(join(root, ".specmarten.json"), { specBackend: "native" });
    await writeJson(globalPath, { specBackend: "openspec" });

    await expect(readConfig(root, { globalPath })).rejects.toThrow("Invalid global SpecMarten config");

    await writeJson(globalPath, { dashboard: { typo: true } });
    await expect(readConfig(root, { globalPath })).rejects.toThrow("Invalid global SpecMarten config");
  });

  it("reports invalid global JSON as a user-facing configuration error", async () => {
    const root = await tempRoot();
    const globalPath = join(root, "config.json");
    await writeJson(join(root, ".specmarten.json"), { specBackend: "native" });
    await writeText(globalPath, "{");

    await expect(readConfig(root, { globalPath })).rejects.toThrow("Failed to parse global SpecMarten config");
  });

  it("writes a project preference without materializing inherited defaults", async () => {
    const root = await tempRoot();
    const projectPath = join(root, ".specmarten.json");
    await writeJson(projectPath, { specBackend: "native" });

    await writeContentLanguage(root, "zh");

    await expect(readJson(projectPath)).resolves.toEqual({
      specBackend: "native",
      language: { content: "zh" }
    });
  });
});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "specmarten-config-test-"));
}
