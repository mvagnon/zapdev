import { log, spinner } from "@clack/prompts";

import { errorMessage } from "../lib/errors";
import type { GitOutputReporter } from "../types/git";

/** Run a CLI step with one uninterrupted spinner and captured Git diagnostics. */
export async function runTask<T>(
  title: string,
  successMessage: string,
  run: (onOutput: GitOutputReporter) => Promise<T>,
): Promise<T> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const loader = interactive ? spinner({ withGuide: false }) : undefined;
  const wasRaw = Boolean(process.stdin.isRaw);
  loader?.start(title);
  if (loader) {
    process.stdin.setRawMode?.(wasRaw);
    process.stdin.pause();
  } else log.info(title);
  try {
    const result = await run(() => undefined);
    if (loader) loader.stop(successMessage);
    else log.success(successMessage);
    return result;
  } catch (error) {
    loader?.clear();
    throw new Error(`${title} failed: ${errorMessage(error)}`, { cause: error });
  }
}
