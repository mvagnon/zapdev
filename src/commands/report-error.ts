import { log, note } from "@clack/prompts";

import { errorMessage } from "../lib/errors";

/** Display a failure with wrapped details in a terminal or plain text otherwise. */
export function reportError(error: unknown): void {
  const message = errorMessage(error);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    log.error("zapdev failed.", { spacing: 0 });
    note(message, "Error details");
  } else {
    log.error(message, { spacing: 0, withGuide: false });
  }
  process.exitCode = 1;
}
