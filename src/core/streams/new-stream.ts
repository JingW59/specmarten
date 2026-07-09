import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { UserFacingError } from "../../util/errors.js";
import { writeText } from "../../util/fs.js";
import { renderViews } from "../renderers/index.js";
import { type SpecMartenState, type SpecMartenStream } from "../state/schema.js";
import { readState, statePath, writeState } from "../state/store.js";

export interface NewStreamOptions {
  root: string;
  label: string;
  id?: string;
  version?: string;
  supersedes?: string;
  parallel?: boolean;
}

export interface NewStreamSummary {
  statePath: string;
  roadmapPath: string;
  dashboardPath: string;
  reportPath: string;
  streamId: string;
  version: string;
  relation: "supersedes" | "parallel" | "first-stream";
  supersedes?: string;
}

export async function runNewStream(options: NewStreamOptions): Promise<NewStreamSummary> {
  const current = await readState(options.root);
  const draft = createNewStreamDraftState(current, options);
  await writeState(options.root, draft);
  await renderViews(options.root, draft);

  const stream = draft.streams.at(-1);
  if (!stream) {
    throw new UserFacingError("Failed to create stream draft.");
  }

  const relation = stream.supersedes ? "supersedes" : current.streams.length === 0 ? "first-stream" : "parallel";
  const reportPath = join(options.root, TOOL.dataDir, "plan-report.md");
  await writeText(reportPath, renderNewStreamReport(stream, relation));

  return {
    statePath: statePath(options.root),
    roadmapPath: join(options.root, TOOL.dataDir, "roadmap.md"),
    dashboardPath: join(options.root, TOOL.dataDir, "dashboard.html"),
    reportPath,
    streamId: stream.id,
    version: stream.version,
    relation,
    supersedes: stream.supersedes
  };
}

export function createNewStreamDraftState(current: SpecMartenState, options: NewStreamOptions): SpecMartenState {
  const label = options.label.trim();
  if (!label) {
    throw new UserFacingError("New stream requires a non-empty label.");
  }
  if (options.parallel && options.supersedes) {
    throw new UserFacingError("Use either --parallel or --supersedes, not both.");
  }

  const version = options.version?.trim() || nextVersion(current);
  const id = options.id?.trim() || version;
  if (!id) {
    throw new UserFacingError("New stream requires a non-empty id.");
  }
  if (!version) {
    throw new UserFacingError("New stream requires a non-empty version.");
  }
  if (current.streams.some((stream) => stream.id === id)) {
    throw new UserFacingError(`Stream id already exists: ${id}`);
  }
  if (current.streams.some((stream) => stream.version === version)) {
    throw new UserFacingError(`Stream version already exists: ${version}`);
  }

  const superseded = options.parallel ? undefined : resolveSupersededStream(current, options.supersedes);
  const streams = current.streams.map((stream) =>
    superseded && stream.id === superseded.id ? { ...stream, state: "maintained" as const } : stream
  );

  const newStream: SpecMartenStream = {
    id,
    version,
    label,
    state: "active",
    phases: []
  };
  if (superseded) {
    newStream.supersedes = superseded.id;
  }

  return {
    ...current,
    draft: true,
    draftKind: "plan",
    updatedAt: new Date().toISOString(),
    currentVersion: version,
    streams: [...streams, newStream]
  };
}

function resolveSupersededStream(current: SpecMartenState, explicitRef: string | undefined): SpecMartenStream | undefined {
  if (current.streams.length === 0) {
    if (explicitRef) {
      throw new UserFacingError(`Cannot supersede missing stream: ${explicitRef}`);
    }
    return undefined;
  }

  const ref = explicitRef?.trim();
  const target = ref
    ? current.streams.find((stream) => stream.id === ref || stream.version === ref)
    : current.streams.find((stream) => stream.version === current.currentVersion || stream.id === current.currentVersion) ??
      current.streams.at(-1);

  if (!target) {
    throw new UserFacingError(`Cannot supersede missing stream: ${ref}`);
  }

  return target;
}

function nextVersion(current: SpecMartenState): string {
  const numbers = current.streams
    .flatMap((stream) => [stream.id, stream.version])
    .map((value) => /^v(\d+)$/.exec(value)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `v${next}`;
}

function renderNewStreamReport(stream: SpecMartenStream, relation: NewStreamSummary["relation"]): string {
  const relationText =
    relation === "supersedes"
      ? `supersedes ${stream.supersedes}`
      : relation === "parallel"
        ? "parallel with existing active stream(s)"
        : "first stream";

  return [
    "# Plan Report",
    "",
    `Requirement: create new stream ${stream.label}`,
    "",
    "## Questions",
    "",
    "- none",
    "",
    "## Notes",
    "",
    `- Created draft stream ${stream.id} (${stream.version}) as ${relationText}.`,
    "- Review the generated roadmap and dashboard, then run `specmarten promote` when ready."
  ].join("\n") + "\n";
}
