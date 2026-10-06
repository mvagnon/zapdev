import { styleText } from "node:util";
import { log, taskLog } from "@clack/prompts";

import { errorMessage, GitOutputError } from "../lib/errors";
import type { GitOutputReporter, HookReporter } from "../types/git";

/** Run a Git action with lazy task logs in a terminal and plain output otherwise. */
export async function runGitTask(
  label: string,
  operation: "commit" | "pull" | "push",
  successMessage: string,
  run: (onHook: HookReporter, onOutput: GitOutputReporter) => Promise<unknown>,
): Promise<boolean> {
  const title = `${label}: ${operation}`;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let task: ReturnType<typeof taskLog> | undefined;
  const onOutput: GitOutputReporter = (chunk, stream) => {
    if (!interactive) {
      process[stream].write(chunk);
      return;
    }
    task ??= taskLog({ title, limit: 10, retainLog: true });
    task.message(chunk, { raw: true });
  };
  const onHook: HookReporter = (event) => {
    const hook = `${label}: ${event.name}`;
    const message = event.phase === "start" ? hook : `${hook}: ${event.exitCode === 0 ? "completed" : `failed (exit ${event.exitCode})`}`;
    if (task) task.message(message);
    else if (event.phase === "start") log.step(styleText("bold", message));
    else if (event.exitCode === 0) log.success(message);
    else log.error(message);
  };
  log.info(title);
  try {
    await run(onHook, onOutput);
    if (task) task.success(successMessage, { showLog: true });
    else log.success(successMessage);
    return true;
  } catch (error) {
    const message = `${label}: ${operation} failed${error instanceof GitOutputError ? "" : `: ${errorMessage(error)}`}`;
    if (task) task.error(message);
    else if (!(error instanceof GitOutputError && error.hookFailureReported)) log.error(message);
    return false;
  }
}
