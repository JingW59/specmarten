import { basename, join } from "node:path";
import { TOOL } from "../../constants.js";
import { pathExists, writeText } from "../../util/fs.js";
import type { SpecMartenState } from "../state/schema.js";

export type PatrolVerdict = "PASS" | "WARN" | "BLOCK";

export interface PatrolReportInput {
  root: string;
  change: string;
  reportBody: string;
  agentName?: string;
}

export interface PatrolReportResult {
  verdict: PatrolVerdict;
  reportRelativePath: string;
  reportAbsolutePath: string;
}

export async function writePatrolReport(input: PatrolReportInput): Promise<PatrolReportResult> {
  const parsed = parseVerdict(input.reportBody);
  const filename = await uniqueReportFilename(input.root, compactTimestamp(new Date()), safeSegment(input.change));
  const reportRelativePath = `reports/${filename}`;
  const reportAbsolutePath = join(input.root, TOOL.dataDir, reportRelativePath);
  const body = parsed.hadVerdict
    ? input.reportBody
    : `${input.reportBody.trimEnd()}\n\n_VERDICT line was missing; SpecMarten downgraded this patrol to WARN._\n\nVERDICT: WARN\n`;
  const report = `---
change: ${yamlScalar(input.change)}
verdict: ${parsed.verdict}
findings: ${countFindings(body)}
agent: ${input.agentName ?? "client-session"}
---
${body.trimStart()}`;

  await writeText(reportAbsolutePath, report);

  return {
    verdict: parsed.verdict,
    reportRelativePath,
    reportAbsolutePath
  };
}

export function applyLastPatrol(
  state: SpecMartenState,
  report: PatrolReportResult,
  change: string,
  at = new Date().toISOString()
): SpecMartenState {
  return {
    ...state,
    lastPatrol: {
      change,
      verdict: report.verdict,
      report: report.reportRelativePath,
      at
    }
  };
}

function parseVerdict(reportBody: string): { verdict: PatrolVerdict; hadVerdict: boolean } {
  const match = reportBody.match(/VERDICT:\s*(PASS|WARN|BLOCK)\s*$/im);
  return {
    verdict: (match?.[1] as PatrolVerdict | undefined) ?? "WARN",
    hadVerdict: Boolean(match)
  };
}

function countFindings(reportBody: string): number {
  const tableLines = reportBody
    .split(/\r?\n/)
    .filter((line) => /^\|\s*\d+\s*\|/.test(line.trim()));
  return tableLines.length;
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function safeSegment(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "change";
}

async function uniqueReportFilename(root: string, timestamp: string, change: string): Promise<string> {
  const base = `${timestamp}-${change}`;
  let filename = `${base}.md`;
  let suffix = 2;

  while (await pathExists(join(root, TOOL.dataDir, "reports", filename))) {
    filename = `${base}-${suffix}.md`;
    suffix += 1;
  }

  return filename;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
