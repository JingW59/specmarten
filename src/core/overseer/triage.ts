import { runProcess } from "../../util/process.js";

export interface TriageConfig {
  sensitivePaths: string[];
  signaturePattern: string;
}

export interface TriageResult {
  hit: boolean;
  changedFiles: string[];
  diffText: string;
  reasons: string[];
}

export async function runTriage(root: string, config: TriageConfig): Promise<TriageResult> {
  const [unstagedFiles, stagedFiles, untrackedFiles, unstagedDiff, stagedDiff] = await Promise.all([
    git(root, ["diff", "--name-only"]),
    git(root, ["diff", "--cached", "--name-only"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
    git(root, ["diff"]),
    git(root, ["diff", "--cached"])
  ]);
  const changedFiles = uniqueLines(`${unstagedFiles}\n${stagedFiles}\n${untrackedFiles}`);
  const diffText = `${unstagedDiff}\n${stagedDiff}`;
  const reasons: string[] = [];

  for (const file of changedFiles) {
    const pattern = config.sensitivePaths.find((candidate) => matchesGlob(file, candidate));
    if (pattern) {
      reasons.push(`file ${file} matched ${pattern}`);
    }
  }

  if (config.signaturePattern) {
    const signature = new RegExp(config.signaturePattern, "m");
    if (signature.test(diffText)) {
      reasons.push(`diff matched signaturePattern ${config.signaturePattern}`);
    }
  }

  return {
    hit: reasons.length > 0,
    changedFiles,
    diffText,
    reasons
  };
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await runProcess("git", args, { cwd: root });
    return result.code === 0 ? result.stdout : "";
  } catch {
    return "";
  }
}

function uniqueLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedFile = filePath.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");

  if (!normalizedPattern.includes("/")) {
    return normalizedFile === normalizedPattern || normalizedFile.endsWith(`/${normalizedPattern}`);
  }

  return globToRegExp(normalizedPattern).test(normalizedFile);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }

  return new RegExp(`^${source}$`);
}

function escapeRegExp(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}
