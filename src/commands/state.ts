import { resolve } from "node:path";
import { Command } from "commander";
import { createSpecBackend, resolveSpecBackendName } from "../adapters/spec-backend/factory.js";
import { TOOL } from "../constants.js";
import { writeBackfillDraft } from "../core/backfill/draft.js";
import { writeMaintainDraft } from "../core/maintenance/draft.js";
import { writePlanDraft } from "../core/planner/draft.js";
import { renderViews } from "../core/renderers/index.js";
import { writeState } from "../core/state/store.js";
import {
  DraftInputError,
  formatDraftInputError,
  parseBackfillDraftJson,
  parseMaintainDraftJson,
  parsePlanDraftJson,
  parseStateDraftJsonIfPresent
} from "../core/state/write-draft.js";
import { UserFacingError } from "../util/errors.js";
import { readText } from "../util/fs.js";

export interface StateCommandIO {
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export function registerStateCommand(
  program: Command,
  io: StateCommandIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
): void {
  const state = program.command("state").description("Validate and write model-produced SpecMarten state drafts.");

  state
    .command("write-draft")
    .description("Validate a model-produced draft and write specmarten/state.json.")
    .requiredOption("--kind <kind>", "draft kind to write: plan, backfill, or maintain")
    .option("--file <path>", "read model JSON from a file instead of stdin")
    .action(async (options: { kind: string; file?: string }) => {
      if (options.kind !== "plan" && options.kind !== "backfill" && options.kind !== "maintain") {
        throw new UserFacingError("state write-draft supports only --kind plan, backfill, or maintain.");
      }

      try {
        const root = process.cwd();
        const rawInput = await readDraftInput(root, options.file, io.stdin);
        const stateDraft = parseStateDraftJsonIfPresent(rawInput, options.kind);
        if (stateDraft) {
          await writeState(root, stateDraft);
          await renderViews(root, stateDraft);
          io.stdout.write(`${TOOL.displayName} wrote a ${options.kind} draft state.\n`);
          io.stdout.write(`State: ${resolve(root, TOOL.dataDir, "state.json")}\n`);
          io.stdout.write("Views rendered: yes\n");
          return;
        }

        if (options.kind === "plan") {
          const response = parsePlanDraftJson(rawInput);
          const summary = await writePlanDraft({
            root,
            response
          });

          io.stdout.write(
            `${TOOL.displayName} wrote a plan draft with ${summary.phases} phases and ${summary.tasks} tasks.\n`
          );
          io.stdout.write(`State: ${summary.statePath}\n`);
          io.stdout.write(`Report: ${summary.reportPath}\n`);
          return;
        }

        if (options.kind === "backfill") {
          const backend = createSpecBackend(root, await resolveSpecBackendName(root));
          const response = parseBackfillDraftJson(rawInput);
          const summary = await writeBackfillDraft({
            root,
            backend,
            response
          });

          io.stdout.write(
            `${TOOL.displayName} wrote a backfill draft with ${summary.phases} phases and ${summary.tasks} tasks.\n`
          );
          io.stdout.write(`State: ${summary.statePath}\n`);
          io.stdout.write(`Report: ${summary.reportPath}\n`);
          if (summary.preservedFormalState) {
            io.stdout.write("Existing formal state was preserved; review the separate draft state file.\n");
          }
          return;
        }

        if (options.kind === "maintain") {
          const backend = createSpecBackend(root, await resolveSpecBackendName(root));
          const response = parseMaintainDraftJson(rawInput);
          const summary = await writeMaintainDraft({
            root,
            backend,
            response
          });

          io.stdout.write(
            `${TOOL.displayName} wrote maintained state with ${summary.phases} phases and ${summary.tasks} tasks.\n`
          );
          io.stdout.write(`State: ${summary.statePath}\n`);
          io.stdout.write("Views rendered: yes\n");
          return;
        }
      } catch (error) {
        if (error instanceof DraftInputError) {
          io.stderr.write(`${formatDraftInputError(error)}\n`);
          process.exitCode = error.exitCode;
          return;
        }

        throw error;
      }
    });
}

async function readDraftInput(root: string, file: string | undefined, stdin: NodeJS.ReadableStream): Promise<string> {
  if (file) {
    return readText(resolve(root, file));
  }

  if ("isTTY" in stdin && stdin.isTTY) {
    throw new UserFacingError("Provide draft JSON with --file <path> or pipe it to stdin.");
  }

  return readStream(stdin);
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolvePromise(output);
    });
    stream.resume();
  });
}
