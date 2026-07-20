import { homedir } from "node:os";
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

const agentPreferenceSchema = z.array(z.enum(["claude", "codex", "gemini"]));
const maintainTriggerSchema = z.enum(["git-post-commit", "claude-post-tool-use"]);
const overseerBlockingSchema = z.enum(["advisory", "pre-archive-block"]);
const contentLanguagePreferenceSchema = contentLanguageSchema;
const backfillGroupBySchema = z.enum(["capability", "time", "flat"]);

export const configSchema = z.object({
  specBackend: z.enum(["native", "openspec"]),
  agent: z
    .object({
      prefer: agentPreferenceSchema.default(["codex", "claude", "gemini"])
    })
    .default({}),
  maintain: z
    .object({
      trigger: maintainTriggerSchema.default("git-post-commit"),
      autoRenderViews: z.boolean().default(true)
    })
    .default({}),
  overseer: z
    .object({
      blocking: overseerBlockingSchema.default("advisory"),
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
      content: contentLanguagePreferenceSchema.default(DEFAULT_CONTENT_LANGUAGE)
    })
    .default({ content: DEFAULT_CONTENT_LANGUAGE }),
  backfill: z
    .object({
      groupBy: backfillGroupBySchema.default("capability"),
      useGit: z.boolean().default(true)
    })
    .default({})
});

export const globalConfigSchema = z
  .object({
    agent: z.object({ prefer: agentPreferenceSchema.optional() }).strict().optional(),
    maintain: z
      .object({
        trigger: maintainTriggerSchema.optional(),
        autoRenderViews: z.boolean().optional()
      })
      .strict()
      .optional(),
    overseer: z
      .object({
        blocking: overseerBlockingSchema.optional(),
        sensitivePaths: z.array(z.string()).optional(),
        signaturePattern: z.string().optional()
      })
      .strict()
      .optional(),
    dashboard: z.object({ autoOpen: z.boolean().optional() }).strict().optional(),
    language: z.object({ content: contentLanguagePreferenceSchema.optional() }).strict().optional(),
    backfill: z
      .object({
        groupBy: backfillGroupBySchema.optional(),
        useGit: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type SpecMartenConfig = z.infer<typeof configSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type SpecBackendName = SpecMartenConfig["specBackend"];
export type ProjectType = "greenfield" | "brownfield";

interface ProjectConfigInput extends GlobalConfig {
  specBackend: SpecBackendName;
}

export interface GlobalConfigPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface ReadConfigOptions {
  globalPath?: string;
}

export function configPath(root: string): string {
  return join(root, TOOL.configFile);
}

export function globalConfigPath(options: GlobalConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitPath = env.SPECMARTEN_CONFIG?.trim();
  if (explicitPath) return explicitPath;

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const platform = options.platform ?? process.platform;
  const platformConfigHome = platform === "win32" ? env.APPDATA?.trim() : undefined;
  const configHome = xdgConfigHome || platformConfigHome || join(options.home ?? homedir(), ".config");
  return join(configHome, TOOL.cliName, "config.json");
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

export async function readConfig(root: string, options: ReadConfigOptions = {}): Promise<SpecMartenConfig> {
  const path = configPath(root);
  try {
    const projectConfig = await readProjectConfig(path);
    const globalConfig = await readGlobalConfig(options.globalPath ?? globalConfigPath());
    const defaults = defaultConfig(projectConfig.specBackend);
    const { specBackend, ...projectOverrides } = projectConfig;
    return mergeConfig(mergeConfig(defaults, globalConfig), projectOverrides, specBackend);
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

async function readProjectConfig(path: string): Promise<ProjectConfigInput> {
  const value = await readJson<unknown>(path);
  configSchema.parse(value);
  return value as ProjectConfigInput;
}

async function readGlobalConfig(path: string): Promise<GlobalConfig> {
  if (!(await pathExists(path))) return {};

  try {
    return globalConfigSchema.parse(await readJson<unknown>(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UserFacingError(`Failed to parse global SpecMarten config at ${path}: invalid JSON.`);
    }
    if (error instanceof z.ZodError) {
      throw new UserFacingError(
        `Invalid global SpecMarten config at ${path}: ${error.issues[0]?.message ?? "invalid value"}.`
      );
    }
    throw error;
  }
}

function mergeConfig(
  base: SpecMartenConfig,
  overrides: GlobalConfig,
  specBackend: SpecBackendName = base.specBackend
): SpecMartenConfig {
  return configSchema.parse({
    specBackend,
    agent: { ...base.agent, ...overrides.agent },
    maintain: { ...base.maintain, ...overrides.maintain },
    overseer: { ...base.overseer, ...overrides.overseer },
    dashboard: { ...base.dashboard, ...overrides.dashboard },
    language: { ...base.language, ...overrides.language },
    backfill: { ...base.backfill, ...overrides.backfill }
  });
}

export async function readContentLanguage(root: string): Promise<ContentLanguage> {
  if (!(await hasConfig(root))) {
    return DEFAULT_CONTENT_LANGUAGE;
  }

  return (await readConfig(root)).language.content;
}

export async function writeContentLanguage(root: string, language: ContentLanguage): Promise<void> {
  const current = (await hasConfig(root))
    ? await readProjectConfig(configPath(root))
    : ({ specBackend: "native" } satisfies ProjectConfigInput);
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
  return writeJsonIfMissing(configPath(root), { specBackend });
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
