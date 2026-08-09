import { Command } from "commander";
import { createSpecBackend } from "../adapters/spec-backend/factory.js";
import { readConfig, type SpecMartenConfig } from "../config/config.js";
import type { SpecBackend } from "../adapters/spec-backend/types.js";
import { isHeadlessRequested } from "./execution-mode.js";

export interface CommandContext {
  config: SpecMartenConfig;
  backend: SpecBackend;
}

export interface HeadlessCommandContext extends CommandContext {
  headless: boolean;
}

export interface HeadlessFlagOptions {
  headless?: boolean;
}

/**
 * Resolves the config and backend for a command from the current working directory.
 *
 * Most read-only and deterministic commands only need these two values. Headless
 * commands should prefer {@link resolveHeadlessContext}, which also evaluates the
 * --headless flag.
 */
export async function resolveConfigAndBackend(root: string): Promise<CommandContext> {
  const config = await readConfig(root);
  const backend = createSpecBackend(root, config.specBackend);
  return { config, backend };
}

/**
 * Resolves config, backend, and the effective headless flag for a command.
 *
 * The headless flag is read from the command-level option, falling back to the
 * program-level --headless option (so `specmarten --headless maintain` works the
 * same as `specmarten maintain --headless`). Agent creation is intentionally left
 * to each command, because the trigger condition and strictness differ (some
 * commands skip the agent unless headless, others require it, and the dependency
 * injection contract for tests varies).
 */
export async function resolveHeadlessContext(
  root: string,
  program: Command,
  options: HeadlessFlagOptions
): Promise<HeadlessCommandContext> {
  const { config, backend } = await resolveConfigAndBackend(root);
  const headless = isHeadlessRequested(options.headless || program.opts().headless);
  return { config, backend, headless };
}
