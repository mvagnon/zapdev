import { basename } from "node:path";
import { WriteStream } from "node:tty";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/git");
vi.mock("../lib/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/config")>(),
  resolvePublishSubtree: vi.fn(),
}));
vi.mock("../lib/gitleaks");
vi.mock("../lib/llm", () => ({ generateCommitMessage: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(), confirm: vi.fn(), intro: vi.fn(), outro: vi.fn(),
  select: vi.fn(), text: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), success: vi.fn() },
  spinner: vi.fn(),
}));

import { confirm, log, select, spinner, text } from "@clack/prompts";
import * as git from "../lib/git";
import { resolvePublishSubtree } from "../lib/config";
import { GitOutputError } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { commitCommand } from "./commit";

const repos = ["/repos/front", "/repos/back"];
const hookLogOptions = { secondarySymbol: "" };
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
  vi.stubEnv("ZD_HOOK_TIMEOUT", undefined);
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
  vi.mocked(resolvePublishSubtree).mockImplementation(async (_directory, override) => override ?? false);
  vi.mocked(git.publishSubtree).mockResolvedValue(true);
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
  expect(confirm).toHaveBeenCalledTimes(1);
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
  expect(confirm).not.toHaveBeenCalled();
});

it.each([false, true])("skips commit review with --yes but confirms sending (subtree=%s)", async (subtree) => {
  vi.mocked(resolvePublishSubtree).mockResolvedValue(subtree);
  vi.mocked(confirm).mockImplementation(async () => {
    expect(git.commit).toHaveBeenCalledTimes(2);
    return true;
  });
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(select).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: `${subtree ? "Publish subtrees in" : "Push"} front (main), back (main)?`,
    initialValue: false,
  }));
  expect(git.push).toHaveBeenCalledTimes(subtree ? 0 : 2);
  expect(git.publishSubtree).toHaveBeenCalledTimes(subtree ? 4 : 0);
});

it.each([false, Symbol("cancel")])("keeps --yes commits local when publication is declined or cancelled: %s", async (answer) => {
  vi.mocked(confirm).mockResolvedValue(answer);
  await runCommand(commitCommand, { rawArgs: ["-y", "--publish-subtree"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  expect(git.publishSubtree).not.toHaveBeenCalled();
});

it.each([false, true])("never prompts or sends with --yes without a TTY (subtree=%s)", async (subtree) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(resolvePublishSubtree).mockResolvedValue(subtree);
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(git.publishSubtree).not.toHaveBeenCalled();
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

it.each(["flag", "file"])("publishes front and back instead of pushing when enabled by %s", async (source) => {
  vi.mocked(git.currentBranch).mockResolvedValue("feature/publish");
  if (source === "file") vi.mocked(resolvePublishSubtree).mockResolvedValue(true);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", ...(source === "flag" ? ["--publish-subtree"] : [])] });

  expect(resolvePublishSubtree).toHaveBeenCalledExactlyOnceWith(process.cwd(), source === "flag" ? true : undefined);
  for (const repo of repos) {
    for (const remote of ["front", "back"]) {
      expect(git.publishSubtree).toHaveBeenCalledWith(repo, remote, "feature/publish", expect.any(Function));
    }
  }
  expect(git.publishSubtree).toHaveBeenCalledTimes(4);
  expect(git.push).not.toHaveBeenCalled();
  expect(git.pushSetUpstream).not.toHaveBeenCalled();
});

it("lets --publish-subtree=false override isSubtree=true", async () => {
  vi.mocked(resolvePublishSubtree).mockImplementation(async (_directory, override) => override ?? true);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", "--publish-subtree=false"] });
  expect(resolvePublishSubtree).toHaveBeenCalledExactlyOnceWith(process.cwd(), false);
  expect(git.push).toHaveBeenCalledTimes(2);
  expect(git.publishSubtree).not.toHaveBeenCalled();
});

it("asks to publish, reports unchanged subtrees and does not enable automatic publication", async () => {
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(git.publishSubtree).mockResolvedValue(false);
  await runCommand(commitCommand, { rawArgs: ["--publish-subtree"] });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Publish subtrees in front (main), back (main)?" }));
  expect(git.publishSubtree).not.toHaveBeenCalled();

  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: ["--publish-subtree"] });
  expect(log.info).toHaveBeenCalledWith("front (main): no changes in projet-front. Skipping.");
});

it("stops a failed publication without classic push recovery and continues other repos", async () => {
  vi.mocked(git.publishSubtree).mockRejectedValueOnce(new Error("Publication rejected"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", "--publish-subtree", "--rebase"] });
  expect(git.publishSubtree).toHaveBeenCalledTimes(3);
  expect(log.error).toHaveBeenCalledWith("front (main): publication to front/main failed: Publication rejected");
  expect(git.push).not.toHaveBeenCalled();
  expect(git.fetchRemote).not.toHaveBeenCalled();
  expect(git.pullRebase).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("rejects invalid zapdev.json before staging or committing", async () => {
  vi.mocked(resolvePublishSubtree).mockRejectedValue(new Error("Invalid zapdev.json"));
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(git.findRepos).not.toHaveBeenCalled();
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("Invalid zapdev.json");
  expect(process.exitCode).toBe(1);
});

it("does not publish from detached HEAD", async () => {
  vi.mocked(git.currentBranch).mockRejectedValue(new Error("HEAD is not a symbolic ref"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", "--publish-subtree"] });
  expect(git.publishSubtree).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("front (main): publication failed: HEAD is not a symbolic ref");
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

it.each(["commit", "push", "fetch", "rebase", "merge", "retry"])("does not repeat native Git diagnostics during %s", async (operation) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  const error = new GitOutputError("Native Git diagnostic");
  if (operation === "commit") vi.mocked(git.commit).mockRejectedValueOnce(error);
  else {
    vi.mocked(git.push).mockRejectedValueOnce(operation === "push" ? error : new Error("Behind upstream"));
    vi.mocked(git.behindCount).mockResolvedValue(operation === "push" ? 0 : 1);
    if (operation === "fetch") vi.mocked(git.fetchRemote).mockRejectedValueOnce(error);
    if (operation === "rebase") vi.mocked(git.pullRebase).mockRejectedValueOnce(error);
    if (operation === "merge") vi.mocked(git.pullMerge).mockRejectedValueOnce(error);
    if (operation === "retry") vi.mocked(git.push).mockRejectedValueOnce(error);
  }

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push", operation === "merge" ? "--merge" : "--rebase"] });

  const status = operation === "commit" ? "commit failed"
    : operation === "fetch" ? "could not check upstream"
    : operation === "rebase" || operation === "merge" ? `${operation === "rebase" ? "Rebase" : "Merge"} failed (resolve conflicts, then push)`
    : "push failed";
  expect(operation === "fetch" ? log.warn : log.error).toHaveBeenCalledWith(`front (main): ${status}`);
  const messages = [...vi.mocked(log.error).mock.calls, ...vi.mocked(log.warn).mock.calls].flat();
  expect(messages.join("\n")).not.toContain("Native Git diagnostic");
  expect(process.exitCode).toBe(1);
});

it("does not report a commit failure twice after the hook has already reported it", async () => {
  vi.mocked(git.commit).mockImplementationOnce(async (_repo, _message, onHook) => {
    onHook!({ name: "commit-msg", phase: "exit", exitCode: 3 });
    throw new GitOutputError("git commit failed", true);
  });

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(log.error).toHaveBeenCalledExactlyOnceWith("front (main): commit-msg: failed (exit 3)", hookLogOptions);
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});

it("still reports explicit hook timeouts in an interactive terminal", async () => {
  vi.mocked(git.commit).mockRejectedValueOnce(new Error("pre-commit hook timed out after 60 seconds"));

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(log.error).toHaveBeenCalledExactlyOnceWith("front (main): commit failed: pre-commit hook timed out after 60 seconds");
  expect(process.exitCode).toBe(1);
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

  expect(log.success).toHaveBeenCalledWith("front (main): pre-commit: completed", hookLogOptions);
  expect(log.error).toHaveBeenCalledWith("front (main): commit-msg: failed (exit 3)", hookLogOptions);
  expect(log.success).toHaveBeenCalledWith("back (main): pre-push: completed", hookLogOptions);
  expect(log.error).toHaveBeenCalledWith("front (main): commit failed: Invalid commit message");
  expect(process.exitCode).toBe(1);
  expect(spinner).toHaveBeenCalledTimes(interactive ? 1 : 0);
  expect(log.step).toHaveBeenCalledWith("front (main): pre-commit", hookLogOptions);
  expect(log.step).toHaveBeenCalledWith("front (main): commit-msg", hookLogOptions);
  expect(log.step).toHaveBeenCalledWith("back (main): pre-push", hookLogOptions);
});

it("rejects an invalid hook timeout before preparing repositories", async () => {
  vi.stubEnv("ZD_HOOK_TIMEOUT", "invalid");
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining("ZD_HOOK_TIMEOUT"));
  expect(git.findRepos).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
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

  expect(log.success).toHaveBeenCalledWith("front (main): reference-transaction: completed", hookLogOptions);
  expect(log.success).toHaveBeenCalledWith(`front (main): ${strategy === "rebase" ? "pre-rebase" : "post-merge"}: completed`, hookLogOptions);
  expect(log.success).toHaveBeenCalledWith("front (main): pre-push: completed", hookLogOptions);
  expect(git.push).toHaveBeenCalledTimes(2);
  expect(spinner).toHaveBeenCalledTimes(1);
});
