import { cancel, confirm, intro, isCancel, log, note, outro, text } from "@clack/prompts";

import { INTERACTION_ARGS } from "../config/interaction-args";
import { errorMessage } from "../lib/errors";
import type { ServiceResult, ServiceSummary } from "../types/service";
import { runTask } from "./git-task";
import { reportError } from "./report-error";

/** Common interaction and machine-output options for workspace commands. */
export const WORKSPACE_ARGS = {
  ...INTERACTION_ARGS,
  json: { type: "boolean", description: "Write only the structured result to stdout; use --non-interactive in a terminal." },
} as const;

/** Optional starting path, prompted with the current directory as its default. */
export const WORKSPACE_PATH = { type: "positional", required: false, description: "Repository, worktree, subdirectory or group; defaults to the current directory." } as const;

type WorkspaceResult = { path?: string; paths?: string[]; services?: (ServiceSummary | ServiceResult)[]; error?: string };
type Options = { "non-interactive"?: boolean; yes?: boolean; json?: boolean };
class Cancelled extends Error {}

/** Prompt for a missing value, confirm effects, and render human or lossless JSON results. */
export async function runWorkspaceTask(name: string, args: Options, run: (ui: {
  input: (value: string | undefined, message: string, fallback?: string, initialValue?: string) => Promise<string>;
  confirm: (message: string) => Promise<void>;
  task: <T>(title: string, success: string, work: () => Promise<T>) => Promise<T>;
}) => Promise<WorkspaceResult>): Promise<void> {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const interactive = terminal && !args["non-interactive"] && !args.yes && !args.json;
  try {
    if (!terminal && !args["non-interactive"] && !args.yes) throw new Error("Use --non-interactive when no terminal is available.");
    if (terminal && args.json && !args["non-interactive"] && !args.yes) throw new Error("Use --non-interactive with --json in a terminal.");
    if (interactive) intro(`zapdev ${name}`);
    const result = await run({
      async input(value, message, fallback, initialValue) {
        if (value !== undefined) return value;
        if (!interactive) {
          if (fallback !== undefined) return fallback;
          throw new Error(`${message} is required in non-interactive mode.`);
        }
        const answer = await text({ message, placeholder: fallback, defaultValue: fallback, initialValue, validate: value =>
          !value?.trim() && fallback === undefined ? "A value is required." : undefined });
        if (isCancel(answer)) throw new Cancelled();
        return answer.trim();
      },
      async confirm(message) {
        if (!interactive) return;
        const answer = await confirm({ message, initialValue: true });
        if (isCancel(answer) || !answer) throw new Cancelled();
      },
      task: (title, success, work) => args.json ? work() : runTask(title, success, work),
    });
    const failed = result.error !== undefined || result.services?.some(service => service.error !== undefined);
    if (failed) process.exitCode = 1;
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    for (const path of result.paths ?? (result.path && !result.services ? [result.path] : [])) log.success(path);
    if (result.services?.length === 0) log.info("No services configured.");
    for (const service of result.services ?? []) {
      log.info(`${service.name}: ${service.path}${service.state ? ` (${service.state})` : ""}`);
      if ("logs" in service && service.logs) note(service.logs, service.name);
      if (service.error) reportError(new Error(service.error));
    }
    if (result.error) reportError(new Error(result.error));
    else if (interactive && !failed) outro("Done.");
  } catch (error) {
    if (error instanceof Cancelled) {
      cancel("Cancelled. Nothing changed.");
    } else if (args.json) {
      process.exitCode = 1;
      process.stdout.write(`${JSON.stringify({ error: errorMessage(error) })}\n`);
    } else reportError(error);
  }
}
