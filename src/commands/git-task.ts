import { styleText } from "node:util";
import { log, spinner, taskLog } from "@clack/prompts";

import { errorMessage, GitOutputError } from "../lib/errors";
import type { GitOutputReporter, HookReporter } from "../types/git";

/** Run a Git action with loading feedback and retained output in a terminal. */
export async function runGitTask(
  label: string,
  operation: "commit" | "pull" | "push",
  successMessage: string,
  run: (onHook: HookReporter, onOutput: GitOutputReporter) => Promise<unknown>,
): Promise<boolean> {
  const title = `${label}: ${operation}`;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const loader = interactive ? spinner({ withGuide: false }) : undefined;
  /** Animate without consuming terminal input intended for Git. */
  const startLoading = (): void => {
    if (!loader) return;
    const wasRaw = Boolean(process.stdin.isRaw);
    loader.start(title);
    process.stdin.setRawMode?.(wasRaw);
    process.stdin.pause();
  };
  let task: ReturnType<typeof taskLog> | undefined;
  const onOutput: GitOutputReporter = (chunk, stream) => {
    if (!interactive) {
      process[stream].write(chunk);
      return;
    }
    if (!task) loader?.clear();
    task ??= taskLog({ title: `${title}: running…`, limit: 10, retainLog: true });
    task.message(chunk, { raw: true });
  };
  const onHook: HookReporter = (event) => {
    loader?.clear();
    if (event.phase === "start" || event.exitCode !== 0) {
      const hook = `${label}: ${event.name}`;
      const message = event.phase === "start" ? `${hook}: running…` : `${hook}: failed (exit ${event.exitCode})`;
      if (task) task.message(message);
      else if (event.phase === "start") log.step(styleText("bold", message));
      else log.error(message);
    }
    if (event.phase === "exit" && !task) startLoading();
  };
  if (!interactive) log.info(title);
  startLoading();
  try {
    await run(onHook, onOutput);
    loader?.clear();
    if (task) task.success(successMessage, { showLog: true });
    else log.success(successMessage);
    return true;
  } catch (error) {
    loader?.clear();
    const message = `${label}: ${operation} failed${error instanceof GitOutputError ? "" : `: ${errorMessage(error)}`}`;
    if (task) task.error(message);
    else if (!(error instanceof GitOutputError && error.hookFailureReported)) log.error(message);
    return false;
  }
}
