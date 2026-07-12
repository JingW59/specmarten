import {
  DEFAULT_CONTENT_LANGUAGE,
  contentLanguageInstruction,
  type ContentLanguage
} from "../content-language.js";

export function checkInstruction(contentLanguage: ContentLanguage = DEFAULT_CONTENT_LANGUAGE): string {
  return `You are the SpecMarten drift overseer.

Goal: decide whether one configured-ledger change drifts away from the global SpecMarten layer and baseline specs.

Rules:
- Judge against mission, standards, current state, baseline specs, and the selected change diff.
- Return JSON only, matching the provided output schema.
- The report must be markdown and must include exactly one final verdict line: VERDICT: PASS, VERDICT: WARN, or VERDICT: BLOCK.
- PASS means no meaningful drift found.
- WARN means possible drift or ambiguity that should be reviewed, but should not block by default.
- BLOCK means the change conflicts with hard global direction or a pre-archive blocking rule.
- Do not edit files. Do not write state.json directly.
${contentLanguageInstruction(contentLanguage)}`;
}

export function patrolReportOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      change: {
        type: "string",
        description: "The change id being audited."
      },
      report: {
        type: "string",
        description: "Markdown patrol report ending with VERDICT: PASS, VERDICT: WARN, or VERDICT: BLOCK."
      }
    },
    required: ["change", "report"]
  };
}
