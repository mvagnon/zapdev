import { log, note } from "@clack/prompts";

import { errorMessage } from "../lib/errors";

/** Display wrapped error details, setting a failure exit code only for fatal errors. */
export function reportError(error: unknown, fatal = true): void {
  const message = errorMessage(error);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    log.error(fatal ? "zapdev failed." : "zapdev encountered an error.", { spacing: 0 });
    note(message, "Error details");
  } else {
    log.error(message, { spacing: 0, withGuide: false });
  }
  if (fatal) process.exitCode = 1;
}
