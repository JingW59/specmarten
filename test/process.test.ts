import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/util/process.js";
import { installBrokenPipeHandler } from "../src/util/stdio.js";

describe("runProcess", () => {
  it("does not leak EPIPE when a successful child exits without reading stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "specmarten-process-test-"));
    const script = join(root, "quick-exit");
    await writeFile(script, "#!/bin/sh\nprintf 'done\\n'\n", "utf8");
    await chmod(script, 0o755);

    const result = await runProcess(script, [], { input: "prompt the child will not read" });

    expect(result).toMatchObject({ code: 0, stdout: "done\n", stderr: "" });
  });

  it("treats CLI broken-pipe output errors as a clean exit", () => {
    const stream = new EventEmitter();
    const exitCodes: number[] = [];
    installBrokenPipeHandler(stream, (code) => {
      exitCodes.push(code);
    });

    stream.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));

    expect(exitCodes).toEqual([0]);
  });
});
