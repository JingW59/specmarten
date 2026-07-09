export interface HardContractFinding {
  kind: "removed-export" | "removed-route";
  location: string;
  evidence: string;
}

export interface HardContractDrift {
  verdict: "BLOCK";
  findings: HardContractFinding[];
  report: string;
}

const removedExportPattern =
  /^-\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const removedRoutePattern =
  /^-\s*(?:export\s+)?(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/i;

export function detectHardContractDrift(diffText: string): HardContractDrift | null {
  const findings: HardContractFinding[] = [];
  let currentFile = "unknown";

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice("+++ b/".length);
      continue;
    }

    if (!isRuntimeSourceFile(currentFile)) {
      continue;
    }

    const removedExport = rawLine.match(removedExportPattern);
    if (removedExport) {
      findings.push({
        kind: "removed-export",
        location: `${currentFile}:${removedExport[1]}`,
        evidence: rawLine.slice(1).trim()
      });
      continue;
    }

    const removedRoute = rawLine.match(removedRoutePattern);
    if (removedRoute) {
      findings.push({
        kind: "removed-route",
        location: `${currentFile}:${removedRoute[1]!.toUpperCase()} ${removedRoute[2]}`,
        evidence: rawLine.slice(1).trim()
      });
    }
  }

  if (findings.length === 0) {
    return null;
  }

  return {
    verdict: "BLOCK",
    findings,
    report: renderHardContractReport(findings)
  };
}

function renderHardContractReport(findings: HardContractFinding[]): string {
  const rows = findings
    .map((finding, index) => {
      const dimension = finding.kind === "removed-route" ? "route endpoint" : "public export";
      return `| ${index + 1} | hard contract | BLOCK | ${finding.location} | Removed ${dimension}: \`${escapePipe(finding.evidence)}\` | Restore the contract or document an intentional breaking change before merging. |`;
    })
    .join("\n");

  return `# Deterministic hard-contract drift
## Summary
SpecMarten detected objective hard-contract removals before model judgment. This verdict is deterministic and was not produced by a headless agent.

## Findings
| # | Dimension | Severity | Location | Evidence | Recommendation |
|---|---|---|---|---|---|
${rows}

VERDICT: BLOCK
`;
}

function escapePipe(value: string): string {
  return value.replaceAll("|", "\\|");
}

function isRuntimeSourceFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (!/\.(?:[cm]?[jt]sx?|cts|mts)$/.test(normalized)) {
    return false;
  }

  return !/(^|\/)(?:test|tests|__tests__)\/|[._-](?:test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}
