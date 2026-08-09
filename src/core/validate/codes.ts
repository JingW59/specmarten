/**
 * Single source of truth for validation issue codes.
 *
 * The string values are part of the machine-readable contract: `validate --json`,
 * closeout summaries, and test assertions reference them by literal value. Keep
 * the values stable when renaming the keys.
 */
export const VALIDATION_CODE = {
  BackendMissing: "backend-missing",
  RoadmapStale: "roadmap-stale",
  DashboardStale: "dashboard-stale",
  AgentMissing: "agent-missing",
  BaselineDrift: "baseline-drift",
  PurposeTbd: "purpose-tbd",
  StateUnreconciled: "specmarten-state-unreconciled",
  ChangeActiveUnlinked: "change-active-unlinked",
  ChangeArchivedUnlinked: "change-archived-unlinked",
  ChangeActiveIncomplete: "change-active-incomplete",
  OpenSpecActiveUnlinked: "openspec-active-unlinked",
  OpenSpecArchivedUnlinked: "openspec-archived-unlinked",
  OpenSpecActiveIncomplete: "openspec-active-incomplete"
} as const;

export type ValidationCodeName = keyof typeof VALIDATION_CODE;
