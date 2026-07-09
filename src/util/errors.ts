export class UserFacingError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "UserFacingError";
    this.exitCode = exitCode;
  }
}

export function errorToExitCode(error: unknown): number {
  return error instanceof UserFacingError ? error.exitCode : 1;
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
