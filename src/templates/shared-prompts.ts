export function renderGlobalContextCheckpoint(statusCommand: string): string {
  return `Before deep work on one change or after a long session, run ${statusCommand} to keep current stream, remaining tasks, and maintenance signals in view. Treat this as read-only context; do not edit \`specmarten/state.json\` directly. If the next step is unclear, run \`specmarten next\`.`;
}

export const CLAUDE_GLOBAL_CONTEXT_CHECKPOINT = renderGlobalContextCheckpoint("`specmarten status --summary-json`");

export const CODEX_GLOBAL_CONTEXT_CHECKPOINT = renderGlobalContextCheckpoint(
  "`specmarten status --summary-json` or `$specmarten-status`"
);

export const STREAM_AWARE_ROADMAP_GUIDANCE =
  "Prefer a stream-aware roadmap: emit `currentVersion` + `streams[]` (each stream carries `phases` or parallel `tracks`, and may `supersede` an older stream) for multi-version or concurrent work. For a large new direction, choose `supersedes` by default and choose `parallel` only when work is genuinely concurrent. Legacy flat `phases[]` is still accepted and wraps into a single active stream.";

export const STREAM_AWARE_BACKFILL_GUIDANCE =
  "Prefer a stream-aware roadmap: emit `currentVersion` + `streams[]` (each stream carries `phases` or parallel `tracks`, and may `supersede` an older stream) to preserve versioned lines and concurrent work. For a large new direction, choose `supersedes` by default and choose `parallel` only when work is genuinely concurrent. Legacy flat `phases[]` is still accepted and wraps into a single active stream.";
