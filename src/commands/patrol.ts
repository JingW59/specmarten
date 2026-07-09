import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { applyLastPatrol, writePatrolReport } from "../core/overseer/patrol.js";
import { readState, writeState } from "../core/state/store.js";
import { UserFacingError } from "../util/errors.js";
import { readText } from "../util/fs.js";

export interface PatrolCommandIO {
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

interface PatrolIssue {
  path: Array<string | number>;
  code?: string;
  message: string;
}

interface PatrolInputErrorBody {
  error: "invalid_patrol_json" | "invalid_patrol_schema";
  message: string;
  issues: PatrolIssue[];
}

class PatrolInputError extends Error {
  readonly body: PatrolInputErrorBody;
  readonly exitCode = 1;

  constructor(body: PatrolInputErrorBody) {
    super(body.message);
    this.name = "PatrolInputError";
    this.body = body;
  }
}

const patrolReportInputSchema = z.object({
  change: z.string().min(1),
  report: z.string().min(1)
});

export function registerPatrolCommand(
  program: Command,
  io: PatrolCommandIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
): void {
  const patrol = program.command("patrol").description("Validate and write model-produced drift patrol reports.");

  patrol
    .command("report")
    .description("Write a model-produced patrol report and update specmarten/state.json lastPatrol.")
    .option("--file <path>", "read patrol JSON from a file instead of stdin")
    .action(async (options: { file?: string }) => {
      try {
        const root = process.cwd();
        const rawInput = await readPatrolInput(root, options.file, io.stdin);
        const input = parsePatrolReportJson(rawInput);
        const report = await writePatrolReport({
          root,
          change: input.change,
          reportBody: input.report
        });
        const state = await readState(root);
        await writeState(root, {
          ...applyLastPatrol(state, report, input.change),
          updatedAt: new Date().toISOString()
        });

        io.stdout.write(`Patrol report: ${report.reportRelativePath}\n`);
        io.stdout.write(`Verdict: ${report.verdict}\n`);
        process.exitCode = report.verdict === "BLOCK" ? 2 : report.verdict === "WARN" ? 10 : 0;
      } catch (error) {
        if (error instanceof PatrolInputError) {
          io.stderr.write(`${formatPatrolInputError(error)}\n`);
          process.exitCode = error.exitCode;
          return;
        }

        throw error;
      }
    });
}

function parsePatrolReportJson(input: string): z.infer<typeof patrolReportInputSchema> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new PatrolInputError({
      error: "invalid_patrol_json",
      message: "Patrol report input is not valid JSON.",
      issues: [
        {
          path: [],
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    });
  }

  const parsed = patrolReportInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new PatrolInputError({
      error: "invalid_patrol_schema",
      message: "Patrol report JSON must match { change, report }.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message
      }))
    });
  }

  return parsed.data;
}

function formatPatrolInputError(error: PatrolInputError): string {
  return JSON.stringify(error.body, null, 2);
}

async function readPatrolInput(root: string, file: string | undefined, stdin: NodeJS.ReadableStream): Promise<string> {
  if (file) {
    return readText(resolve(root, file));
  }

  if ("isTTY" in stdin && stdin.isTTY) {
    throw new UserFacingError("Provide patrol report JSON with --file <path> or pipe it to stdin.");
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
