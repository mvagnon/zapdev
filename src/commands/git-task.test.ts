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
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(spinner).mockReturnValue(loader);
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
});

afterEach(() => {
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  vi.restoreAllMocks();
});

it.each([true, false])("starts and stops once without reacting to Git output (TTY=%s)", async (interactive) => {
  process.stdout.isTTY = interactive;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(runTask("repo: pull", "repo: pulled", async (onOutput) => {
    onOutput("stdout", "stdout");
    onOutput("stderr", "stderr");
    expect(loader.start).toHaveBeenCalledTimes(interactive ? 1 : 0);
    expect(loader.stop).not.toHaveBeenCalled();
    expect(loader.clear).not.toHaveBeenCalled();
    return 42;
  })).resolves.toBe(42);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  expect(loader.clear).not.toHaveBeenCalled();
  expect(taskLog).not.toHaveBeenCalled();
  if (interactive) {
    expect(loader.start).toHaveBeenCalledExactlyOnceWith("repo: pull");
    expect(loader.stop).toHaveBeenCalledExactlyOnceWith("repo: pulled");
  } else {
    expect(spinner).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("repo: pull");
    expect(log.success).toHaveBeenCalledExactlyOnceWith("repo: pulled");
  }
});

it.each([true, false])("stops the spinner and propagates captured failure diagnostics (TTY=%s)", async (interactive) => {
  process.stdout.isTTY = interactive;
  await expect(runTask("repo: commit", "repo: committed", async (onOutput) => {
    onOutput("native diagnostic\n", "stderr");
    throw new GitOutputError("native diagnostic");
  })).rejects.toThrow("repo: commit failed: native diagnostic");
  expect(loader.clear).toHaveBeenCalledTimes(interactive ? 1 : 0);
  expect(loader.stop).not.toHaveBeenCalled();
  expect(log.success).not.toHaveBeenCalled();
  expect(taskLog).not.toHaveBeenCalled();
});
