import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
  taskLog: vi.fn(),
  spinner: vi.fn(),
}));

import { log, spinner, taskLog } from "@clack/prompts";
import { GitOutputError } from "../lib/errors";
import { runGitTask } from "./git-task";

const block = { message: vi.fn(), success: vi.fn(), error: vi.fn(), group: vi.fn() };
const loader = { start: vi.fn(), stop: vi.fn(), error: vi.fn(), cancel: vi.fn(), message: vi.fn(), clear: vi.fn(), isCancelled: false };
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(taskLog).mockReturnValue(block);
  vi.mocked(spinner).mockReturnValue(loader);
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
});

afterEach(() => {
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  vi.restoreAllMocks();
});

it("streams partial native output without successful hook statuses into one retained task log", async () => {
  const success = await runGitTask("repo", "push", "repo: pushed", async (onHook, onOutput) => {
    onOutput("Partial", "stdout");
    onOutput(" output\n", "stderr");
    onHook({ name: "pre-push", phase: "exit", exitCode: 0 });
  });

  expect(success).toBe(true);
  expect(taskLog).toHaveBeenCalledExactlyOnceWith({ title: "repo: push: running…", limit: 10, retainLog: true });
  expect(loader.start).toHaveBeenCalledTimes(1);
  expect(block.message.mock.calls).toEqual([
    ["Partial", { raw: true }], [" output\n", { raw: true }],
  ]);
  expect(block.success).toHaveBeenCalledExactlyOnceWith("repo: pushed", { showLog: true });
  expect(log.success).not.toHaveBeenCalled();
});

it("does not create an empty block for a silent command", async () => {
  await expect(runGitTask("repo", "commit", "repo: committed", async () => {
    expect(loader.start).toHaveBeenCalledExactlyOnceWith("repo: commit");
  })).resolves.toBe(true);
  expect(loader.clear).toHaveBeenCalledTimes(1);
  expect(taskLog).not.toHaveBeenCalled();
  expect(log.success).toHaveBeenCalledExactlyOnceWith("repo: committed");
});

it("retains failed output without repeating native diagnostics", async () => {
  await expect(runGitTask("repo", "commit", "repo: committed", async (_onHook, onOutput) => {
    onOutput("native diagnostic\n", "stderr");
    throw new GitOutputError("native diagnostic");
  })).resolves.toBe(false);
  expect(block.error).toHaveBeenCalledExactlyOnceWith("repo: commit failed");
  expect(log.error).not.toHaveBeenCalled();
});

it("streams stdout and stderr directly without task logs outside a terminal", async () => {
  process.stdout.isTTY = false;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await expect(runGitTask("repo", "pull", "repo: pulled", async (_onHook, onOutput) => {
    onOutput("stdout", "stdout");
    onOutput("stderr", "stderr");
  })).resolves.toBe(true);
  expect(stdout).toHaveBeenCalledWith("stdout");
  expect(stderr).toHaveBeenCalledWith("stderr");
  expect(taskLog).not.toHaveBeenCalled();
  expect(spinner).not.toHaveBeenCalled();
});
