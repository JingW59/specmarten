export interface ErrorWritable {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export function installBrokenPipeHandler(
  stream: ErrorWritable,
  exit: (code: number) => void = process.exit
): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      exit(0);
      return;
    }

    throw error;
  });
}

export function installBrokenPipeHandlers(): void {
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);
}
