import { spawn } from "node:child_process";

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const settleReject = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    child.on("error", settleReject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
        return;
      }
      settleReject(error);
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });

    try {
      if (opts.input) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") {
        settleReject(error as Error);
      }
    }
  });
}

export async function commandExists(command: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";

  try {
    const result = await runProcess(probe, [command], { env });
    return result.code === 0;
  } catch {
    return false;
  }
}
