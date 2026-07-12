import { join } from "node:path";
import { z } from "zod";
import { TOOL } from "../constants.js";
import {
  DEFAULT_CONTENT_LANGUAGE,
  contentLanguageSchema,
  type ContentLanguage
} from "../core/content-language.js";
import { pathExists, readJson, writeJson, writeJsonIfMissing } from "../util/fs.js";
import { UserFacingError } from "../util/errors.js";
import type { SpecBackend } from "../adapters/spec-backend/types.js";

export const configSchema = z.object({
  specBackend: z.enum(["native", "openspec"]),
  agent: z
    .object({
      prefer: z.array(z.enum(["claude", "codex", "gemini"])).default(["codex", "claude", "gemini"])
    })
    .default({}),
  maintain: z
    .object({
      trigger: z.enum(["git-post-commit", "claude-post-tool-use"]).default("git-post-commit"),
      autoRenderViews: z.boolean().default(true)
    })
    .default({}),
  overseer: z
    .object({
      blocking: z.enum(["advisory", "pre-archive-block"]).default("advisory"),
      sensitivePaths: z.array(z.string()).default([
        "**/api/**",
        "**/models.*",
        "**/cli.*",
        "package.json",
        "pyproject.toml"
      ]),
      signaturePattern: z.string().default("^[+-]\\s*(def |class |export |func |public )")
    })
    .default({}),
  dashboard: z
    .object({
      autoOpen: z.boolean().default(false)
    })
    .default({}),
  language: z
    .object({
      content: contentLanguageSchema.default(DEFAULT_CONTENT_LANGUAGE)
    })
    .default({ content: DEFAULT_CONTENT_LANGUAGE }),
  backfill: z
    .object({
      groupBy: z.enum(["capability", "time", "flat"]).default("capability"),
      useGit: z.boolean().default(true)
    })
    .default({})
});

export type SpecMartenConfig = z.infer<typeof configSchema>;
export type SpecBackendName = SpecMartenConfig["specBackend"];
export type ProjectType = "greenfield" | "brownfield";

export function configPath(root: string): string {
  return join(root, TOOL.configFile);
}

export function defaultConfig(specBackend: SpecBackendName = "native"): SpecMartenConfig {
  return configSchema.parse({
    specBackend,
    agent: { prefer: ["codex", "claude", "gemini"] },
    maintain: { trigger: "git-post-commit", autoRenderViews: true },
    overseer: {
      blocking: "advisory",
      sensitivePaths: ["**/api/**", "**/models.*", "**/cli.*", "package.json", "pyproject.toml"],
      signaturePattern: "^[+-]\\s*(def |class |export |func |public )"
    },
    dashboard: { autoOpen: false },
    language: { content: DEFAULT_CONTENT_LANGUAGE },
    backfill: { groupBy: "capability", useGit: true }
  });
}

export async function readConfig(root: string): Promise<SpecMartenConfig> {
  const path = configPath(root);
  try {
    return configSchema.parse(await readJson<unknown>(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserFacingError(
        `${TOOL.displayName} is not initialized in this repository. Run \`${TOOL.cliName} init\` first.`
      );
    }
    if (error instanceof SyntaxError) {
      throw new UserFacingError(
        `Failed to parse ${TOOL.configFile}: invalid JSON. Restore the file or rerun \`${TOOL.cliName} init\` in a clean project.`
      );
    }
    throw error;
  }
}

export async function readContentLanguage(root: string): Promise<ContentLanguage> {
  if (!(await hasConfig(root))) {
    return DEFAULT_CONTENT_LANGUAGE;
  }

  return (await readConfig(root)).language.content;
}

export async function writeContentLanguage(root: string, language: ContentLanguage): Promise<void> {
  const current = (await hasConfig(root)) ? await readConfig(root) : defaultConfig();
  await writeJson(configPath(root), {
    ...current,
    language: {
      ...current.language,
      content: language
    }
  });
}

export async function writeDefaultConfigIfMissing(
  root: string,
  specBackend: SpecBackendName = "native"
): Promise<boolean> {
  return writeJsonIfMissing(configPath(root), defaultConfig(specBackend));
}

export async function hasConfig(root: string): Promise<boolean> {
  return pathExists(configPath(root));
}

export async function detectProjectType(backend: SpecBackend): Promise<ProjectType> {
  const [activeChanges, archivedChanges] = await Promise.all([
    backend.listActiveChanges(),
    backend.listArchivedChanges()
  ]);

  return activeChanges.length > 0 || archivedChanges.length > 0 ? "brownfield" : "greenfield";
}
