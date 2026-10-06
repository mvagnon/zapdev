import { basename } from "node:path";
import { WriteStream } from "node:tty";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/git");
vi.mock("../lib/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/config")>(),
  resolveSubtrees: vi.fn(),
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
import { resolveSubtrees } from "../lib/config";
import { GitOutputError } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { commitCommand } from "./commit";

const repos = ["/repos/front", "/repos/back"];
const subtrees = { "projet-front": "front", "projet-back": "back" };
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
  vi.mocked(git.currentBranch).mockResolvedValue("main");
  vi.mocked(git.getPushRemote).mockResolvedValue("origin");
  vi.mocked(resolveSubtrees).mockResolvedValue({});
  vi.mocked(git.hasSubtreeChanges).mockResolvedValue(true);
  vi.mocked(text).mockResolvedValue("feature/publish");
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
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "origin", "feature/publish", expect.any(Function));
  expect(confirm).not.toHaveBeenCalled();
});

it.each([false, true])("skips commit review with --yes but confirms sending (subtree=%s)", async (subtree) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? subtrees : {});
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
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(confirm).mockResolvedValue(answer);
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  expect(git.publishSubtree).not.toHaveBeenCalled();
});

it.each([false, true])("never prompts or sends with --yes without a TTY (subtree=%s)", async (subtree) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? subtrees : {});
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

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Push back (main)?" }));
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "origin", "feature/publish", expect.any(Function));
  expect(process.exitCode).toBe(1);
});

it("publishes exactly the configured folders to their mapped remotes", async () => {
  vi.mocked(git.currentBranch).mockResolvedValue("feature/publish");
  const mapping = { "apps/ui": "frontend", "services/api": "backend" };
  vi.mocked(resolveSubtrees).mockResolvedValue(mapping);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(resolveSubtrees).toHaveBeenCalledExactlyOnceWith(process.cwd());
  for (const repo of repos) {
    for (const [prefix, remote] of Object.entries(mapping)) {
      expect(git.hasSubtreeChanges).toHaveBeenCalledWith(repo, prefix, remote, expect.any(Function));
      expect(git.publishSubtree).toHaveBeenCalledWith(repo, prefix, remote, "feature/publish", expect.any(Function));
    }
  }
  expect(git.publishSubtree).toHaveBeenCalledTimes(4);
  expect(git.push).not.toHaveBeenCalled();
  expect(text).toHaveBeenCalledTimes(4);
  expect(git.getPushRemote).not.toHaveBeenCalled();
});

it("asks to publish, reports unchanged subtrees and does not enable automatic publication", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(git.hasSubtreeChanges).mockResolvedValue(false);
  await runCommand(commitCommand, { rawArgs: [] });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Publish subtrees in front (main), back (main)?" }));
  expect(git.publishSubtree).not.toHaveBeenCalled();

  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: [] });
  expect(log.info).toHaveBeenCalledWith("front (main): no changes in projet-front. Skipping.");
  expect(text).not.toHaveBeenCalled();
  expect(git.publishSubtree).not.toHaveBeenCalled();
});

it("stops all publications after a rejection", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.publishSubtree).mockRejectedValueOnce(new Error("Publication rejected"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(git.publishSubtree).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledTimes(1);
  expect(log.error).toHaveBeenCalledWith("front (main): publication failed: Publication rejected");
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("asks separately for each changed subtree and skips unchanged ones before prompting", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.hasSubtreeChanges).mockResolvedValueOnce(false);
  vi.mocked(git.currentBranch).mockResolvedValueOnce("main").mockResolvedValueOnce("fix/api");
  vi.mocked(text)
    .mockResolvedValueOnce("  feature/back  ")
    .mockResolvedValueOnce("feature/other-front")
    .mockImplementationOnce(async ({ initialValue }) => initialValue!);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).toHaveBeenCalledTimes(3);
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({
    message: "front (main): branch to push projet-back to back",
    initialValue: "main",
  }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/back" }));
  expect(text).toHaveBeenNthCalledWith(3, expect.objectContaining({ initialValue: "feature/other-front" }));
  expect(vi.mocked(git.publishSubtree).mock.calls).toEqual([
    ["/repos/front", "projet-back", "back", "feature/back", expect.any(Function)],
    ["/repos/back", "projet-front", "front", "feature/other-front", expect.any(Function)],
    ["/repos/back", "projet-back", "back", "feature/other-front", expect.any(Function)],
  ]);
});

it("rejects invalid zapdev.json before staging or committing", async () => {
  vi.mocked(resolveSubtrees).mockRejectedValue(new Error("Invalid zapdev.json"));
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(git.findRepos).not.toHaveBeenCalled();
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("Invalid zapdev.json");
  expect(process.exitCode).toBe(1);
});

it("does not publish from detached HEAD", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.currentBranch).mockRejectedValue(new Error("HEAD is not a symbolic ref"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
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

it("always asks for a destination and pushes the trimmed input to each resolved remote", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce("upstream").mockResolvedValueOnce("server");
  vi.mocked(text).mockResolvedValueOnce("  feature/front  ").mockResolvedValueOnce("feature/back");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenCalledWith(expect.objectContaining({
    message: "front (main): branch to push to upstream",
    initialValue: "main",
  }));
  expect(git.push).toHaveBeenCalledWith("/repos/front", "upstream", "feature/front", expect.any(Function));
  expect(git.push).toHaveBeenCalledWith("/repos/back", "server", "feature/back", expect.any(Function));
});

it("warns and skips an unresolved remote without prompting, then sends the next repo", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce(null).mockResolvedValueOnce("server");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledWith("front (main): no remote or ambiguous remote choice. Skipping push; commit remains local.");
  expect(text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: "back (main): branch to push to server",
  }));
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "server", "feature/publish", expect.any(Function));
  expect(select).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("stops all remaining sends after Git rejects a push", async () => {
  vi.mocked(text).mockResolvedValue("feature/publish");
  vi.mocked(git.push).mockRejectedValueOnce(new Error("non-fast-forward"));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.push).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("stops sending when a destination input is cancelled", async () => {
  vi.mocked(text).mockResolvedValue(Symbol("cancel"));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each([false, true])("refuses --push without a terminal (subtree=%s)", async (subtree) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? subtrees : {});

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(git.publishSubtree).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each(["commit", "push", "publication"])("does not repeat native Git diagnostics during %s", async (operation) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(operation === "publication" ? subtrees : {});
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  const error = new GitOutputError("Native Git diagnostic");
  if (operation === "commit") vi.mocked(git.commit).mockRejectedValueOnce(error);
  else if (operation === "push") vi.mocked(git.push).mockRejectedValueOnce(error);
  else vi.mocked(git.publishSubtree).mockRejectedValueOnce(error);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(log.error).toHaveBeenCalledWith(`front (main): ${operation} failed`);
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
  vi.mocked(git.push).mockImplementation(async (_repo, _remote, _branch, onHook) => {
    onHook!({ name: "pre-push", phase: "start" });
    onHook!({ name: "pre-push", phase: "exit", exitCode: 0 });
  });

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(log.success).toHaveBeenCalledWith("front (main): pre-commit: completed", hookLogOptions);
  expect(log.error).toHaveBeenCalledWith("front (main): commit-msg: failed (exit 3)", hookLogOptions);
  if (interactive) expect(log.success).toHaveBeenCalledWith("back (main): pre-push: completed", hookLogOptions);
  else expect(git.push).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("front (main): commit failed: Invalid commit message");
  expect(process.exitCode).toBe(1);
  expect(spinner).toHaveBeenCalledTimes(interactive ? 1 : 0);
  expect(log.step).toHaveBeenCalledWith("front (main): pre-commit", hookLogOptions);
  expect(log.step).toHaveBeenCalledWith("front (main): commit-msg", hookLogOptions);
  if (interactive) expect(log.step).toHaveBeenCalledWith("back (main): pre-push", hookLogOptions);
});

it("rejects an invalid hook timeout before preparing repositories", async () => {
  vi.stubEnv("ZD_HOOK_TIMEOUT", "invalid");
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining("ZD_HOOK_TIMEOUT"));
  expect(git.findRepos).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
