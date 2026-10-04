import { basename } from "node:path";
import { WriteStream } from "node:tty";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/git");
vi.mock("../lib/gitleaks");
vi.mock("../lib/llm", () => ({ generateCommitMessage: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(), confirm: vi.fn(), intro: vi.fn(), outro: vi.fn(),
  select: vi.fn(), text: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), success: vi.fn() },
  spinner: vi.fn(),
}));

import { confirm, log, select, spinner, text } from "@clack/prompts";
import * as git from "../lib/git";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { commitCommand } from "./commit";

const repos = ["/repos/front", "/repos/back"];
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
const stdoutGetColorDepth = process.stdout.getColorDepth;
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(spinner).mockImplementation(() => ({
    start: vi.fn(), stop: vi.fn(), error: vi.fn(), cancel: vi.fn(),
    message: vi.fn(), clear: vi.fn(), isCancelled: false,
  }));
  vi.stubEnv("ZD_URL", "http://localhost:1234/v1/chat/completions");
  vi.stubEnv("ZD_MODEL", "test-model");
  vi.stubEnv("ZD_EFFORT", "low");
  vi.stubEnv("NO_COLOR", "1");
  vi.stubEnv("FORCE_COLOR", undefined);
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.stdout.getColorDepth = WriteStream.prototype.getColorDepth;
  process.exitCode = undefined;
  vi.mocked(git.findRepos).mockResolvedValue(repos);
  vi.mocked(git.getStagedDiff).mockImplementation(async (repo) => repo);
  vi.mocked(git.hasUpstream).mockResolvedValue(true);
  vi.mocked(git.currentBranch).mockResolvedValue("main");
  vi.mocked(git.getRepoStatus).mockResolvedValue({ branch: "main", hasChanges: true });
  vi.mocked(hasGitleaks).mockResolvedValue(true);
  vi.mocked(generateCommitMessage).mockImplementation(async (diff) => `fix: ${basename(diff)}`);
  vi.mocked(confirm).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  process.stdout.getColorDepth = stdoutGetColorDepth;
  process.exitCode = exitCode;
});

it("generates all messages concurrently before committing any repository", async () => {
  const pending: (() => void)[] = [];
  vi.mocked(generateCommitMessage).mockImplementation((diff) => new Promise((resolve) => {
    expect(git.commit).not.toHaveBeenCalled();
    pending.push(() => resolve(`fix: ${basename(diff)}`));
    if (pending.length === repos.length) pending.forEach((finish) => finish());
  }));

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(git.stageAll).toHaveBeenCalledTimes(2);
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/front");
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/back");
  expect(git.commit).toHaveBeenCalledWith("/repos/front", "fix: front", expect.any(Function));
  expect(git.commit).toHaveBeenCalledWith("/repos/back", "fix: back", expect.any(Function));
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
}, 1_000);

it("honors --staged and skips clean repositories when committing and pushing", async () => {
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");
  await runCommand(commitCommand, { rawArgs: ["-syp"] });

  expect(git.stageAll).not.toHaveBeenCalled();
  expect(scanStagedChanges).toHaveBeenCalledExactlyOnceWith("/repos/back");
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function));
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", expect.any(Function));
  expect(git.fetchRemote).not.toHaveBeenCalled();
});

it("never sends a failed secret scan to the LLM and still processes the other repo", async () => {
  vi.mocked(scanStagedChanges).mockImplementation(async (repo) => {
    if (repo === "/repos/front") throw new Error("Secret detected");
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(generateCommitMessage).toHaveBeenCalledTimes(1);
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/back", expect.any(Object), undefined);
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function));
  expect(process.exitCode).toBe(1);
});

it("edits one repo, then commits only that repo with its edited message", async () => {
  vi.mocked(select)
    .mockImplementationOnce(async ({ options }) => options[4]!.value)
    .mockImplementationOnce(async ({ options }) => options[2]!.value);
  vi.mocked(text).mockResolvedValue("  fix: edited back  ");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: edited back", expect.any(Function));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({
    options: expect.arrayContaining([
      expect.objectContaining({ label: 'Commit only "back (main)"' }),
      expect.objectContaining({ label: 'Edit message for "back (main)"' }),
    ]),
  }));
  expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Edit message for "back (main)"' }));
  expect(git.push).not.toHaveBeenCalled();
});

it.each(["color", "pipe", "NO_COLOR"])("shows branches and highlights only pending changes: %s", async (output) => {
  vi.stubEnv("NO_COLOR", output === "NO_COLOR" ? "1" : undefined);
  vi.stubEnv("NODE_DISABLE_COLORS", undefined);
  vi.stubEnv("FORCE_COLOR", output === "color" ? "1" : undefined);
  process.stdout.isTTY = output !== "pipe";
  vi.mocked(git.getRepoStatus)
    .mockResolvedValueOnce({ branch: "main", hasChanges: false })
    .mockResolvedValueOnce({ branch: "fix/api", hasChanges: true });
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  const label = output === "color" ? "\u001b[1m\u001b[4mback (fix/api)\u001b[24m\u001b[22m" : "back (fix/api)";
  expect(log.info).toHaveBeenCalledWith("front (main): nothing to commit.");
  expect(log.message).toHaveBeenCalledExactlyOnceWith(`${label}: fix: back`);
  expect(log.success).toHaveBeenCalledExactlyOnceWith("back (fix/api): committed fix: back");
});

it("accepts all repos and asks once before pushing only the successful commits", async () => {
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(git.commit).mockRejectedValueOnce(new Error("Hook failed"));
  vi.mocked(git.hasUpstream).mockResolvedValue(false);

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Push back (main)?" }));
  expect(git.pushSetUpstream).toHaveBeenCalledExactlyOnceWith("/repos/back", "main", expect.any(Function));
  expect(process.exitCode).toBe(1);
});

it.each(["cancel", Symbol("cancel")])("leaves every repo uncommitted on cancellation: %s", async (choice) => {
  vi.mocked(select).mockResolvedValue(choice);
  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("scopes push recovery to the rejected repository", async () => {
  vi.mocked(git.push).mockRejectedValueOnce(new Error("Behind upstream"));
  vi.mocked(git.behindCount).mockResolvedValue(1);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", "--rebase"] });

  expect(git.fetchRemote).toHaveBeenCalledExactlyOnceWith("/repos/front", expect.any(Function));
  expect(git.pullRebase).toHaveBeenCalledExactlyOnceWith("/repos/front", expect.any(Function));
  expect(vi.mocked(git.push).mock.calls).toEqual([
    ["/repos/front", expect.any(Function)], ["/repos/front", expect.any(Function)], ["/repos/back", expect.any(Function)],
  ]);
});

it.each(["empty", "error"])("skips a repo whose generation returns %s", async (failure) => {
  if (failure === "empty") vi.mocked(generateCommitMessage).mockResolvedValueOnce("");
  else vi.mocked(generateCommitMessage).mockRejectedValueOnce(new Error("LLM unavailable"));
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function));
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each([true, false])("shows actual hook progress and results with TTY=%s", async (interactive) => {
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  vi.mocked(git.commit).mockImplementation(async (repo, _message, onHook) => {
    if (repo !== repos[0]) return;
    onHook!({ name: "pre-commit", phase: "start" });
    onHook!({ name: "pre-commit", phase: "exit", exitCode: 0 });
    onHook!({ name: "commit-msg", phase: "start" });
    onHook!({ name: "commit-msg", phase: "exit", exitCode: 3 });
    throw new Error("Invalid commit message");
  });
  vi.mocked(git.push).mockImplementation(async (_repo, onHook) => {
    onHook!({ name: "pre-push", phase: "start" });
    onHook!({ name: "pre-push", phase: "exit", exitCode: 0 });
  });

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(log.success).toHaveBeenCalledWith("front (main): pre-commit ✓");
  expect(log.error).toHaveBeenCalledWith("front (main): commit-msg ✗ (exit 3)");
  expect(log.success).toHaveBeenCalledWith("back (main): pre-push ✓");
  expect(log.error).toHaveBeenCalledWith("front (main): commit failed: Invalid commit message");
  expect(process.exitCode).toBe(1);
  if (interactive) {
    const messages = vi.mocked(spinner).mock.results.flatMap(({ value }) => vi.mocked(value.message).mock.calls.flat());
    expect(messages).toContain("front (main): pre-commit running…");
    expect(messages).toContain("front (main): commit-msg running…");
    expect(messages).toContain("back (main): pre-push running…");
  } else {
    expect(spinner).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("front (main): pre-commit running…");
  }
});

it.each(["rebase", "merge"])("observes hooks during fetch, %s and push retry", async (strategy) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(git.push).mockRejectedValueOnce(new Error("Behind upstream"));
  vi.mocked(git.behindCount).mockResolvedValue(1);
  vi.mocked(git.fetchRemote).mockImplementation(async (_repo, onHook) => {
    onHook!({ name: "reference-transaction", phase: "start" });
    onHook!({ name: "reference-transaction", phase: "exit", exitCode: 0 });
  });
  vi.mocked(strategy === "rebase" ? git.pullRebase : git.pullMerge).mockImplementation(async (_repo, onHook) => {
    onHook!({ name: strategy === "rebase" ? "pre-rebase" : "post-merge", phase: "start" });
    onHook!({ name: strategy === "rebase" ? "pre-rebase" : "post-merge", phase: "exit", exitCode: 0 });
  });
  vi.mocked(git.push).mockImplementationOnce(async (_repo, onHook) => {
    onHook!({ name: "pre-push", phase: "start" });
    onHook!({ name: "pre-push", phase: "exit", exitCode: 0 });
  });

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", `--${strategy}`] });

  expect(log.success).toHaveBeenCalledWith("front (main): reference-transaction ✓");
  expect(log.success).toHaveBeenCalledWith(`front (main): ${strategy === "rebase" ? "pre-rebase" : "post-merge"} ✓`);
  expect(log.success).toHaveBeenCalledWith("front (main): pre-push ✓");
  expect(git.push).toHaveBeenCalledTimes(2);
});
