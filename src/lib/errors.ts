/** A failed Git command whose diagnostics have already been displayed. */
export class GitOutputError extends Error {
  constructor(message: string, readonly hookFailureReported: boolean = false) {
    super(message);
  }
}

/** An invalid generated message that can be retried with its conversation intact. */
export class InvalidCommitMessageError extends Error {
  constructor(message: string, readonly retry: () => Promise<string>) {
    super(message);
  }
}

/** Get a readable diagnostic from an unknown error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
