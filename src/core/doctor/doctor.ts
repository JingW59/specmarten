import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL } from "../../constants.js";
import { pathExists } from "../../util/fs.js";
import { runProcess } from "../../util/process.js";

export interface DoctorSummary {
  version: typeof TOOL.version;
  commitHash: string | null;
  packagePath: string | null;
  gitRemote: string | null;
  buildTime: string | null;
}

export async function runDoctor(): Promise<DoctorSummary> {
  const packagePath = await findPackageRoot(dirname(fileURLToPath(import.meta.url)));

  return {
    version: TOOL.version,
    commitHash: packagePath ? await gitOutput(packagePath, ["rev-parse", "--short", "HEAD"]) : null,
    packagePath,
    gitRemote: packagePath ? await gitOutput(packagePath, ["config", "--get", "remote.origin.url"]) : null,
    buildTime: process.env.SPECMARTEN_BUILD_TIME || null
  };
}

export function formatDoctor(summary: DoctorSummary): string {
  return [
    "SpecMarten Doctor",
    `Version: ${summary.version}`,
    `Commit: ${summary.commitHash ?? "unknown"}`,
    `Package path: ${summary.packagePath ?? "unknown"}`,
    `Git remote: ${summary.gitRemote ?? "unknown"}`,
    `Build time: ${summary.buildTime ?? "unknown"}`
  ].join("\n") + "\n";
}

async function findPackageRoot(start: string): Promise<string | null> {
  let current = start;
  while (true) {
    if (await pathExists(join(current, "package.json"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess("git", args, { cwd });
    const output = result.stdout.trim();
    return result.code === 0 && output ? output : null;
  } catch {
    return null;
  }
}
