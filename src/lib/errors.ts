/** A failed Git command with terminal-inherited output. */
export class GitOutputError extends Error {
  constructor(message: string, readonly hookFailureReported: boolean = false) {
    super(message);
  }
}

/** Get a readable diagnostic from an unknown error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
