import { log, spinner, taskLog } from "@clack/prompts";

import { errorMessage } from "../lib/errors";
import type { GitOutputReporter, HookReporter } from "../types/git";

/** Run a CLI step, deferring output until completion unless hooks need live terminal access. */
export async function runTask<T>(
  title: string,
  successMessage: string,
  run: (onOutput: GitOutputReporter, onHook: HookReporter) => Promise<T>,
  withGuide = true,
): Promise<T> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const loader = interactive ? spinner({ withGuide }) : undefined;
  const wasRaw = Boolean(process.stdin.isRaw);
  let outputLog: ReturnType<typeof taskLog> | undefined;
  const pendingOutput: string[] = [];
  let hooksAnnounced = false;
  let stderr = "";
  const getLog = (): ReturnType<typeof taskLog> => {
    if (!outputLog) {
      loader?.clear();
      outputLog = taskLog({ title, spacing: 0, retainLog: true });
      for (const chunk of pendingOutput) outputLog.message(chunk, { raw: true });
      pendingOutput.length = 0;
    }
    return outputLog;
  };
  loader?.start(title);
  if (loader) {
    process.stdin.setRawMode?.(wasRaw);
    process.stdin.pause();
  } else log.info(title);
  try {
    const result = await run((chunk, stream) => {
      if (!chunk) return;
      if (stream === "stderr") stderr += chunk;
      if (outputLog) outputLog.message(chunk, { raw: true });
      else pendingOutput.push(chunk);
    }, (event) => {
      if (event.phase !== "start" || hooksAnnounced) return;
      hooksAnnounced = true;
      getLog().message("Running hooks");
    });
    if (pendingOutput.length) getLog();
    if (outputLog) outputLog.success(successMessage, { showLog: true });
    else if (loader) loader.stop(successMessage);
    else log.success(successMessage, { spacing: 0 });
    return result;
  } catch (error) {
    if (pendingOutput.length) getLog();
    if (outputLog) outputLog.error(`${title} failed`);
    else loader?.clear();
    const message = errorMessage(error);
    const diagnostic = stderr.trim();
    const detail = diagnostic && message.includes(diagnostic)
      ? message.replace(diagnostic, "command failed (see output above)")
      : message;
    throw new Error(`${title} failed: ${detail}`, { cause: error });
  }
}
