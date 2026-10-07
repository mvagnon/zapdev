import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
  taskLog: vi.fn(),
  spinner: vi.fn(),
}));

import { log, spinner, taskLog } from "@clack/prompts";
import { GitOutputError } from "../lib/errors";
import { runTask } from "./git-task";

const loader = { start: vi.fn(), stop: vi.fn(), error: vi.fn(), cancel: vi.fn(), message: vi.fn(), clear: vi.fn(), isCancelled: false };
const outputLog = { message: vi.fn(), success: vi.fn(), error: vi.fn(), group: vi.fn() };
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(spinner).mockReturnValue(loader);
  vi.mocked(taskLog).mockReturnValue(outputLog);
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
});

afterEach(() => {
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  vi.restoreAllMocks();
});

it.each([true, false])("renders native output in a task log without overlapping the spinner (TTY=%s)", async (interactive) => {
  process.stdout.isTTY = interactive;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(runTask("repo: pull", "repo: pulled", async (onOutput) => {
    onOutput("stdout", "stdout");
    onOutput("stderr", "stderr");
    expect(loader.start).toHaveBeenCalledTimes(interactive ? 1 : 0);
    expect(loader.stop).not.toHaveBeenCalled();
    expect(loader.clear).toHaveBeenCalledTimes(interactive ? 1 : 0);
    return 42;
  })).resolves.toBe(42);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  expect(taskLog).toHaveBeenCalledExactlyOnceWith({ title: "repo: pull", spacing: 0, retainLog: true });
  expect(outputLog.message.mock.calls).toEqual([["stdout", { raw: true }], ["stderr", { raw: true }]]);
  expect(outputLog.success).toHaveBeenCalledExactlyOnceWith("repo: pulled", { showLog: true });
  if (interactive) {
    expect(spinner).toHaveBeenCalledExactlyOnceWith({ withGuide: true });
    expect(loader.start).toHaveBeenCalledExactlyOnceWith("repo: pull");
    expect(loader.stop).not.toHaveBeenCalled();
  } else {
    expect(spinner).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("repo: pull");
    expect(log.success).not.toHaveBeenCalled();
  }
});

it("does not add another spacer when an empty prompt already left one", async () => {
  await runTask("repo: commit", "repo: committed", async () => undefined, false);
  expect(spinner).toHaveBeenCalledExactlyOnceWith({ withGuide: false });
});

it.each([true, false])("retains failure output in the task log (TTY=%s)", async (interactive) => {
  process.stdout.isTTY = interactive;
  await expect(runTask("repo: commit", "repo: committed", async (onOutput) => {
    onOutput("native diagnostic\n", "stderr");
    throw new GitOutputError("native diagnostic");
  })).rejects.toThrow("repo: commit failed: command failed (see output above)");
  expect(loader.clear).toHaveBeenCalledTimes(interactive ? 1 : 0);
  expect(loader.stop).not.toHaveBeenCalled();
  expect(log.success).not.toHaveBeenCalled();
  expect(outputLog.error).toHaveBeenCalledExactlyOnceWith("repo: commit failed");
});

it("announces sequential hooks once in the same task log, including silent hooks", async () => {
  await runTask("repo: commit", "repo: committed", async (onOutput, onHook) => {
    onHook({ name: "pre-commit", phase: "start" });
    onOutput("hook output\n", "stderr");
    onHook({ name: "pre-commit", phase: "exit", exitCode: 0 });
    onHook({ name: "commit-msg", phase: "start" });
    onHook({ name: "commit-msg", phase: "exit", exitCode: 0 });
  });
  expect(taskLog).toHaveBeenCalledTimes(1);
  expect(outputLog.message.mock.calls).toEqual([["Running hooks"], ["hook output\n", { raw: true }]]);
  expect(loader.clear).toHaveBeenCalledTimes(1);
  expect(outputLog.success).toHaveBeenCalledWith("repo: committed", { showLog: true });
});

it("keeps the spinner for commands without output or hooks", async () => {
  await runTask("repo: commit", "repo: committed", async () => undefined);
  expect(taskLog).not.toHaveBeenCalled();
  expect(loader.stop).toHaveBeenCalledExactlyOnceWith("repo: committed");
});
