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
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), success: vi.fn() },
  spinner: vi.fn(),
  taskLog: vi.fn(),
}));

import { cancel, confirm, log, outro, select, spinner, taskLog, text } from "@clack/prompts";
import * as git from "../lib/git";
import { GitOutputError } from "../lib/errors";
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
  vi.mocked(taskLog).mockImplementation(() => ({ message: vi.fn(), success: vi.fn(), error: vi.fn(), group: vi.fn() }));
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
  vi.mocked(git.getStagedDiffStats).mockResolvedValue({ additions: 12, deletions: 3 });
  const branches = new Map(repos.map((repo) => [repo, "main"]));
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => branches.get(repo) ?? "main");
  vi.mocked(git.switchBranch).mockImplementation(async (repo, branch) => { branches.set(repo, branch); });
  vi.mocked(git.getUpstreamRemote).mockResolvedValue("origin");
  vi.mocked(git.getPushRemote).mockResolvedValue("origin");
  vi.mocked(text).mockResolvedValue("");
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
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/front", expect.any(Function));
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/back", expect.any(Function));
  expect(git.commit).toHaveBeenCalledWith("/repos/front", "fix: front", expect.any(Function), expect.any(Function));
  expect(git.commit).toHaveBeenCalledWith("/repos/back", "fix: back", expect.any(Function), expect.any(Function));
  expect(select).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  expect(git.git).not.toHaveBeenCalled();
}, 1_000);

it.each([false, true])("does not offer or attempt push when no repository has an unambiguous remote (push=%s)", async (push) => {
  vi.mocked(git.getPushRemote).mockResolvedValue(null);

  await runCommand(commitCommand, { rawArgs: ["--yes", ...(push ? ["--push"] : [])] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("only offers repositories with a resolved remote in the push prompt", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce(null).mockResolvedValueOnce("origin");
  vi.mocked(confirm).mockResolvedValue(true);

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Push back (main)?" }));
  expect(git.push).toHaveBeenCalledExactlyOnceWith(repos[1], "origin", "main", expect.any(Function), expect.any(Function));
});

it.each([false, true])("publishes a new branch without an upstream, confirming unless --push is set (push=%s)", async (push) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(git.getUpstreamRemote).mockResolvedValue(null);
  vi.mocked(text).mockResolvedValue("feature/new");
  vi.mocked(confirm).mockResolvedValue(true);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull", ...(push ? ["--push"] : [])] });

  expect(git.git).not.toHaveBeenCalled();
  expect(git.getPushRemote).toHaveBeenCalledExactlyOnceWith(repos[0], "feature/new");
  expect(git.push).toHaveBeenCalledExactlyOnceWith(repos[0], "origin", "feature/new", expect.any(Function), expect.any(Function));
  expect(confirm).toHaveBeenCalledTimes(push ? 0 : 1);
});

it("pulls concurrently, waits for every pull, then prepares and generates concurrently", async () => {
  let completedPulls = 0;
  const pulling: (() => void)[] = [];
  const staging: (() => void)[] = [];
  const generating: (() => void)[] = [];
  const spinnerStates: boolean[] = [];
  const recordPullingSpinner = (): void => {
    const loader = vi.mocked(spinner).mock.results[0]!.value;
    const start = vi.mocked(loader.start).mock;
    const clear = vi.mocked(loader.clear).mock;
    spinnerStates.push(start.calls.at(-1)?.[0] === "Pulling repositories in parallel"
      && (start.invocationCallOrder.at(-1) ?? 0) > (clear.invocationCallOrder.at(-1) ?? 0));
  };
  vi.mocked(git.git).mockImplementation((_args, _repo, onHook, onOutput) => new Promise((resolve) => {
    expect(git.stageAll).not.toHaveBeenCalled();
    expect(git.getStagedDiff).not.toHaveBeenCalled();
    expect(hasGitleaks).not.toHaveBeenCalled();
    expect(generateCommitMessage).not.toHaveBeenCalled();
    recordPullingSpinner();
    onOutput!("Git output\n", "stdout");
    recordPullingSpinner();
    expect(onHook).toEqual(expect.any(Function));
    pulling.push(() => { completedPulls++; resolve(""); });
    if (pulling.length === repos.length) {
      pulling[0]!();
      setImmediate(() => {
        recordPullingSpinner();
        pulling[1]!();
      });
    }
  }));
  vi.mocked(git.stageAll).mockImplementation(() => new Promise((resolve) => {
    expect(completedPulls).toBe(repos.length);
    expect(generateCommitMessage).not.toHaveBeenCalled();
    staging.push(resolve);
    if (staging.length === repos.length) staging.forEach((finish) => finish());
  }));
  vi.mocked(generateCommitMessage).mockImplementation((diff) => new Promise((resolve) => {
    generating.push(() => resolve(`fix: ${basename(diff)}`));
    if (generating.length === repos.length) generating.forEach((finish) => finish());
  }));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull"] });

  expect(spinnerStates).toEqual([true, true, true, true, true]);
  expect(vi.mocked(git.git).mock.calls).toEqual(repos.map((repo) => [["pull", "--ff-only", "--no-rebase", "--no-autostash"], repo, expect.any(Function), expect.any(Function)]));
  expect(vi.mocked(git.git).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(git.stageAll).mock.invocationCallOrder[0]!);
  expect(git.commit).toHaveBeenCalledTimes(2);
  const loader = vi.mocked(spinner).mock.results[0]!.value;
  expect(loader.start).toHaveBeenCalledExactlyOnceWith("Pulling repositories in parallel");
  expect(loader.stop).not.toHaveBeenCalled();
  expect(loader.clear).toHaveBeenCalledTimes(1);
  expect(vi.mocked(spinner).mock.results[1]!.value.start).toHaveBeenCalledExactlyOnceWith("Preparing repositories and generating commit messages in parallel");
  expect(taskLog).toHaveBeenCalledTimes(1);
}, 1_000);

it.each([[false, true], [true, true], [false, false], [true, false]])("only pulls commit candidates (staged=%s, changes=%s)", async (staged, changes) => {
  vi.mocked(git.getRepoStatus).mockImplementation(async (repo) => ({
    branch: "main", hasChanges: staged || Boolean(changes && repo === repos[1]),
  }));
  vi.mocked(git.getStagedDiff).mockImplementation(async (repo) => changes && repo === repos[1] ? "back" : " \n");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull", ...(staged ? ["--staged"] : [])] });

  expect(vi.mocked(git.git).mock.calls).toEqual(changes ? [
    [["pull", "--ff-only", "--no-rebase", "--no-autostash"], repos[1], expect.any(Function), expect.any(Function)],
  ] : []);
  expect(git.getUpstreamRemote).not.toHaveBeenCalledWith(repos[0], expect.anything());
  expect(git.commit).toHaveBeenCalledTimes(changes ? 1 : 0);
  expect(generateCommitMessage).toHaveBeenCalledTimes(changes ? 1 : 0);
  expect(process.exitCode).toBeUndefined();
});

it.each([false, true])("skips pull without an upstream remote and continues committing (all=%s)", async (all) => {
  vi.mocked(git.getUpstreamRemote).mockImplementation(async (repo) => all || repo === repos[0] ? null : "origin");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull"] });

  expect(vi.mocked(git.git).mock.calls).toEqual(all ? [] : [
    [["pull", "--ff-only", "--no-rebase", "--no-autostash"], repos[1], expect.any(Function), expect.any(Function)],
  ]);
  expect(git.getUpstreamRemote).toHaveBeenCalledWith(repos[0], "main");
  expect(log.warn).toHaveBeenCalledWith("front: no configured upstream remote. Skipping pull.", { spacing: 0 });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBeUndefined();
});

it("finishes other pulls but never stages when an upstream remote lookup fails", async () => {
  vi.mocked(git.getUpstreamRemote).mockRejectedValueOnce(new Error("Cannot read upstream"));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull"] });

  expect(git.git).toHaveBeenCalledExactlyOnceWith(["pull", "--ff-only", "--no-rebase", "--no-autostash"], repos[1], expect.any(Function), expect.any(Function));
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(git.commit).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledExactlyOnceWith("Pulling repositories in parallel failed: front: Cannot read upstream", { spacing: 0 });
  expect(process.exitCode).toBe(1);
});

it.each([new Error("Diverged history"), new GitOutputError("Native Git diagnostic")])("waits for every pull without staging any repository when one fails: %s", async (error) => {
  const pulling: (() => void)[] = [];
  let completedPulls = 0;
  vi.mocked(git.git).mockImplementation((_args, repo) => new Promise((resolve, reject) => {
    expect(git.stageAll).not.toHaveBeenCalled();
    pulling.push(() => {
      completedPulls++;
      if (repo === repos[0]) reject(error);
      else resolve("");
    });
    if (pulling.length === repos.length) {
      pulling[0]!();
      setImmediate(pulling[1]!);
    }
  }));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--pull"] });

  expect(completedPulls).toBe(repos.length);
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(generateCommitMessage).not.toHaveBeenCalled();
  expect(git.commit).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledExactlyOnceWith(`Pulling repositories in parallel failed: front: ${error.message}`, { spacing: 0 });
  expect(vi.mocked(spinner).mock.results[0]!.value.stop).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
}, 1_000);

it.each([false, true])("honors --staged and only offers or pushes the newly committed repository (push=%s)", async (push) => {
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");
  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: [push ? "-syp" : "-sy"] });

  expect(git.stageAll).not.toHaveBeenCalled();
  expect(scanStagedChanges).toHaveBeenCalledExactlyOnceWith("/repos/back", expect.any(Function));
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function), expect.any(Function));
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "origin", "main", expect.any(Function), expect.any(Function));
  expect(git.getPushRemote).toHaveBeenCalledExactlyOnceWith("/repos/back", "main");
  if (push) expect(confirm).not.toHaveBeenCalled();
  else expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Push back (main)?" }));
});

it.each([false, true])("never offers or pushes repositories without a new commit (push=%s)", async (push) => {
  vi.mocked(git.getStagedDiff).mockResolvedValue("");
  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: push ? ["--push"] : [] });
  expect(git.commit).not.toHaveBeenCalled();
  expect(generateCommitMessage).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(git.getUpstreamRemote).not.toHaveBeenCalled();
  expect(git.getPushRemote).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each(["main", "master", "principal", "dev", "development"])("chooses the local branch immediately before committing on %s", async (branch) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(git.currentBranch).mockResolvedValue(branch);
  vi.mocked(text).mockImplementation(async () => {
    expect(git.commit).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    return "  feature/local  ";
  });
  vi.mocked(select).mockResolvedValue("all");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: `front (${branch}): branch to commit to`, initialValue: "",
  }));
  expect(git.switchBranch).toHaveBeenCalledExactlyOnceWith(repos[0], "feature/local", expect.any(Function), expect.any(Function));
  expect(vi.mocked(git.switchBranch).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(git.commit).mock.invocationCallOrder[0]!);
  expect(git.commit).toHaveBeenCalledTimes(1);
});

it.each(["feature/main", "main-fix", "fix/dev", "develop", "feature/current"])("never asks for a branch when committing or pushing on %s", async (branch) => {
  vi.mocked(git.currentBranch).mockResolvedValue(branch);

  await runCommand(commitCommand, { rawArgs: ["-yp"] });

  expect(text).not.toHaveBeenCalled();
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual([branch, branch]);
});

it.each([undefined, "--ask-for-branch", "-A"])("refuses commits requiring a branch prompt without a terminal (flag=%s)", async (flag) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  if (flag) vi.mocked(git.currentBranch).mockResolvedValue("feature/current");

  await runCommand(commitCommand, { rawArgs: ["-yp", ...(flag ? [flag] : [])] });

  expect(text).not.toHaveBeenCalled();
  expect(git.commit).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each(["--ask-for-branch", "-A"])("asks for a branch in every selected repository with %s, even with --yes and --push", async (flag) => {
  const branches = new Map([[repos[0]!, "feature/front"], [repos[1]!, "fix/api"]]);
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => branches.get(repo)!);
  vi.mocked(git.switchBranch).mockImplementation(async (repo, branch) => { branches.set(repo, branch); });
  vi.mocked(text).mockResolvedValueOnce("  feature/shared  ")
    .mockImplementationOnce(async ({ initialValue }) => initialValue!);

  await runCommand(commitCommand, { rawArgs: ["-yp", flag] });

  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: "front (feature/front): branch to commit to", initialValue: "" }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: "back (fix/api): branch to commit to", initialValue: "feature/shared" }));
  for (const [index, repo] of repos.entries()) {
    expect(git.switchBranch).toHaveBeenNthCalledWith(index + 1, repo, "feature/shared", expect.any(Function), expect.any(Function));
    expect(vi.mocked(git.switchBranch).mock.invocationCallOrder[index]).toBeLessThan(vi.mocked(git.commit).mock.invocationCallOrder[index]!);
    expect(git.push).toHaveBeenNthCalledWith(index + 1, repo, "origin", "feature/shared", expect.any(Function), expect.any(Function));
  }
  expect(process.exitCode).toBeUndefined();
});

it("uses the current branch for cleared input, retaining the previous input default", async () => {
  vi.mocked(git.findRepos).mockResolvedValue([...repos, "/repos/other"]);
  vi.mocked(text).mockResolvedValue("  ").mockResolvedValueOnce("feature/previous");
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialValue: "" }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/previous" }));
  expect(text).toHaveBeenNthCalledWith(3, expect.objectContaining({ initialValue: "" }));
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["feature/previous", "main", "main"]);
  expect(git.switchBranch).toHaveBeenCalledExactlyOnceWith("/repos/front", "feature/previous", expect.any(Function), expect.any(Function));
  expect(process.exitCode).toBeUndefined();
});

it("reuses the previous input across repositories", async () => {
  vi.mocked(text).mockResolvedValueOnce("  feature/shared  ")
    .mockImplementationOnce(async ({ initialValue }) => initialValue!);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialValue: "" }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/shared" }));
  expect(git.push).toHaveBeenCalledTimes(2);
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["feature/shared", "feature/shared"]);
});

it("keeps empty inputs empty and sends to each repository's current branch, including main", async () => {
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => repo === repos[0] ? "main" : "dev");
  vi.mocked(text).mockImplementation(async ({ initialValue }) => initialValue!);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenCalledTimes(2);
  for (const [options] of vi.mocked(text).mock.calls) expect(options.initialValue).toBe("");
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["main", "dev"]);
  expect(git.switchBranch).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("skips commit review with --yes but confirms sending", async () => {
  vi.mocked(confirm).mockImplementation(async () => {
    expect(git.commit).toHaveBeenCalledTimes(2);
    return true;
  });
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(select).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: "Push front (main), back (main)?",
    initialValue: false,
  }));
  expect(git.push).toHaveBeenCalledTimes(2);
});

it.each(["--push=false", "--no-push"])("keeps commits local without push confirmation with %s", async (flag) => {
  vi.mocked(confirm).mockResolvedValue(true);

  await runCommand(commitCommand, { rawArgs: ["--yes", flag] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(git.getPushRemote).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each([false, Symbol("cancel")])("keeps --yes commits local when push is declined or cancelled: %s", async (answer) => {
  vi.mocked(confirm).mockResolvedValue(answer);
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  if (typeof answer === "symbol") {
    expect(cancel).toHaveBeenCalledExactlyOnceWith("Committed. Not pushed.");
    expect(outro).not.toHaveBeenCalled();
  } else expect(outro).toHaveBeenCalledExactlyOnceWith("Done.");
});

it("never prompts or sends with --yes without a TTY", async () => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
});

it("never sends a failed secret scan to the LLM and stops before committing any repo", async () => {
  vi.mocked(scanStagedChanges).mockImplementation(async (repo) => {
    if (repo === "/repos/front") throw new Error("Secret detected");
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(generateCommitMessage).toHaveBeenCalledTimes(1);
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/back", expect.any(Object), undefined);
  expect(git.commit).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("edits one repo, then commits only that repo with its edited message", async () => {
  vi.mocked(select)
    .mockImplementationOnce(async ({ options }) => options[4]!.value)
    .mockImplementationOnce(async ({ options }) => options[2]!.value);
  vi.mocked(text).mockResolvedValueOnce("  fix: edited back  ");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: edited back", expect.any(Function), expect.any(Function));
  expect(log.message).toHaveBeenCalledWith("(+12 -3) back (main): fix: edited back", { spacing: 0 });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({
    options: expect.arrayContaining([
      expect.objectContaining({ label: 'Commit only "back (main)"' }),
      expect.objectContaining({ label: 'Edit message for "back (main)"' }),
    ]),
  }));
  expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Edit message for "back (main)"' }));
  expect(text).toHaveBeenCalledTimes(2);
  const validate = vi.mocked(text).mock.calls[0]![0].validate!;
  if (typeof validate !== "function") throw new Error("Expected a validation function.");
  expect(validate("banana: invalid")).toEqual(expect.any(String));
  expect(validate("feat(api)!: remove the old endpoint")).toBeUndefined();
  expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ message: "back (main): branch to commit to" }));
  expect(git.push).not.toHaveBeenCalled();
});

it.each(["color", "pipe", "NO_COLOR"])("prefixes pending commit messages with colored staged diff stats: %s", async (output) => {
  vi.stubEnv("NO_COLOR", output === "NO_COLOR" ? "1" : undefined);
  vi.stubEnv("NODE_DISABLE_COLORS", undefined);
  vi.stubEnv("FORCE_COLOR", output === "color" ? "1" : undefined);
  process.stdout.isTTY = output !== "pipe";
  vi.mocked(git.currentBranch).mockResolvedValue("fix/api");
  vi.mocked(git.getRepoStatus)
    .mockResolvedValueOnce({ branch: "main", hasChanges: false })
    .mockResolvedValueOnce({ branch: "fix/api", hasChanges: true });
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  const label = output === "color" ? "\u001b[1mback (fix/api)\u001b[22m" : "back (fix/api)";
  const stats = output === "color" ? "(\u001b[32m+12\u001b[39m \u001b[31m-3\u001b[39m)" : "(+12 -3)";
  expect(log.info).toHaveBeenCalledWith("front (main): nothing to commit.", { spacing: 0 });
  expect(log.message).toHaveBeenCalledExactlyOnceWith(`${stats} ${label}: fix: back`, { spacing: 1 });
  expect(git.getStagedDiffStats).toHaveBeenCalledExactlyOnceWith("/repos/back");
  if (output === "pipe") expect(log.success).toHaveBeenCalledWith("back (fix/api): committed fix: back", { spacing: 0 });
  else expect(vi.mocked(spinner).mock.results.at(-1)!.value.stop).toHaveBeenCalledExactlyOnceWith("back (fix/api): committed fix: back");
});

it("stops remaining commits and never asks to push after a commit failure", async () => {
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(git.commit).mockRejectedValueOnce(new Error("Hook failed"));

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("pushes each actual current branch without querying remote history", async () => {
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => repo === repos[0] ? "feature/front" : "fix/api");
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(git.push).toHaveBeenNthCalledWith(1, "/repos/front", "origin", "feature/front", expect.any(Function), expect.any(Function));
  expect(git.push).toHaveBeenNthCalledWith(2, "/repos/back", "origin", "fix/api", expect.any(Function), expect.any(Function));
  expect(git.git).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(git.push).toHaveBeenCalledTimes(2);
});

it("pushes immediately after confirmation without a preliminary fetch", async () => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(git.push).mockImplementation(async () => {
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledTimes(1);
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(git.push).toHaveBeenCalledTimes(1);
  expect(git.git).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("checking unpublished"));
  expect(process.exitCode).toBeUndefined();
});

it("does not push from detached HEAD", async () => {
  vi.mocked(git.currentBranch).mockResolvedValueOnce("feature/front").mockResolvedValueOnce("feature/back")
    .mockRejectedValue(new Error("HEAD is not a symbolic ref"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(git.push).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("HEAD is not a symbolic ref", { spacing: 0 });
  expect(process.exitCode).toBe(1);
});

it.each(["cancel", Symbol("cancel")])("leaves every repo uncommitted on cancellation: %s", async (choice) => {
  vi.mocked(select).mockResolvedValue(choice);
  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("creates the trimmed local branch before committing and pushes it to each resolved remote", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce("upstream").mockResolvedValueOnce("server");
  vi.mocked(text).mockResolvedValueOnce("  feature/front  ").mockResolvedValueOnce("feature/back");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenCalledWith(expect.objectContaining({
    message: "front (main): branch to commit to",
    initialValue: "",
  }));
  expect(git.push).toHaveBeenCalledWith("/repos/front", "upstream", "feature/front", expect.any(Function), expect.any(Function));
  expect(git.push).toHaveBeenCalledWith("/repos/back", "server", "feature/back", expect.any(Function), expect.any(Function));
  expect(confirm).not.toHaveBeenCalled();
});

it("warns and skips an unresolved remote, then sends the next repo's current branch", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce(null).mockResolvedValueOnce("server");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledWith("front (main): no unambiguous push remote. Skipping push; commit remains local.", { spacing: 0 });
  expect(text).toHaveBeenCalledTimes(2);
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "server", "main", expect.any(Function), expect.any(Function));
  expect(select).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it.each([undefined, new Error("non-fast-forward"), new GitOutputError("Native Git diagnostic")])("pushes concurrently and waits for every push before reporting the result: %s", async (error) => {
  const pushing: (() => void)[] = [];
  let completedPushes = 0;
  let errorsBeforeLastPush = -1;
  let exitCodeBeforeLastPush: typeof process.exitCode;
  vi.mocked(git.push).mockImplementation((repo) => new Promise((resolve, reject) => {
    pushing.push(() => {
      completedPushes++;
      if (repo === repos[0] && error) reject(error);
      else resolve();
    });
    if (pushing.length === repos.length) {
      pushing[0]!();
      setImmediate(() => {
        errorsBeforeLastPush = vi.mocked(log.error).mock.calls.length;
        exitCodeBeforeLastPush = process.exitCode;
        pushing[1]!();
      });
    }
  }));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.push).toHaveBeenCalledTimes(repos.length);
  expect(completedPushes).toBe(repos.length);
  expect(errorsBeforeLastPush).toBe(0);
  expect(exitCodeBeforeLastPush).toBeUndefined();
  expect(text).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
  const loader = vi.mocked(spinner).mock.results.at(-1)!.value;
  expect(loader.start).toHaveBeenCalledExactlyOnceWith("Pushing repositories in parallel");
  if (error) {
    expect(log.error).toHaveBeenCalledExactlyOnceWith(`Pushing repositories in parallel failed: front (main): ${error.message}`, { spacing: 0 });
    expect(loader.stop).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } else {
    expect(log.error).not.toHaveBeenCalled();
    expect(loader.stop).toHaveBeenCalledExactlyOnceWith("Repositories pushed");
    expect(process.exitCode).toBeUndefined();
  }
}, 1_000);

it("stops before committing or sending when a branch input is cancelled", async () => {
  vi.mocked(text).mockResolvedValue(Symbol("cancel"));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.commit).not.toHaveBeenCalled();
  expect(text).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("keeps earlier commits local when the next branch input is cancelled", async () => {
  vi.mocked(text).mockResolvedValueOnce("feature/front").mockResolvedValueOnce(Symbol("cancel"));
  await runCommand(commitCommand, { rawArgs: ["-yp"] });
  expect(git.commit).toHaveBeenCalledExactlyOnceWith(repos[0], "fix: front", expect.any(Function), expect.any(Function));
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("stops all remaining commits and pushes when a branch switch fails", async () => {
  vi.mocked(text).mockResolvedValue("feature/shared");
  vi.mocked(git.switchBranch).mockRejectedValueOnce(new Error("Local changes would be overwritten"));
  await runCommand(commitCommand, { rawArgs: ["-yp"] });
  expect(git.commit).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("allows --push without a terminal on nonprotected branches", async () => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).not.toHaveBeenCalled();
  expect(git.push).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBeUndefined();
});

it.each(["commit", "push"])("reports captured native Git diagnostics once during %s", async (operation) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  const error = new GitOutputError("Native Git diagnostic");
  if (operation === "commit") vi.mocked(git.commit).mockRejectedValueOnce(error);
  else vi.mocked(git.push).mockRejectedValueOnce(error);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  const message = operation === "commit"
    ? "front (main): commit failed: Native Git diagnostic"
    : "Pushing repositories in parallel failed: front (main): Native Git diagnostic";
  expect(log.error).toHaveBeenCalledExactlyOnceWith(message, { spacing: 0 });
  const messages = [...vi.mocked(log.error).mock.calls, ...vi.mocked(log.warn).mock.calls].map(([message]) => message);
  expect(messages.join("\n").match(/Native Git diagnostic/g)).toHaveLength(1);
  expect(process.exitCode).toBe(1);
});

it("reports a failed hook once without separate hook statuses", async () => {
  vi.mocked(git.commit).mockRejectedValueOnce(new GitOutputError("commit-msg failed (exit 3)", true));

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(log.error).toHaveBeenCalledExactlyOnceWith("front (main): commit failed: commit-msg failed (exit 3)", { spacing: 0 });
  expect(git.commit).toHaveBeenCalledTimes(1);
  expect(log.step).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("still reports explicit hook timeouts in an interactive terminal", async () => {
  vi.mocked(git.commit).mockRejectedValueOnce(new Error("pre-commit hook timed out after 60 seconds"));

  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(log.error).toHaveBeenCalledExactlyOnceWith("front (main): commit failed: pre-commit hook timed out after 60 seconds", { spacing: 0 });
  expect(process.exitCode).toBe(1);
});

it.each(["empty", "error"])("stops before committing any repo when generation returns %s", async (failure) => {
  if (failure === "empty") vi.mocked(generateCommitMessage).mockResolvedValueOnce("");
  else vi.mocked(generateCommitMessage).mockRejectedValueOnce(new Error("LLM unavailable"));
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each([true, false])("routes hooks and native output through task logs with TTY=%s", async (interactive) => {
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  if (!interactive) vi.mocked(git.currentBranch).mockResolvedValue("feature/current");
  vi.mocked(git.commit).mockImplementation(async (_repo, _message, onHook, onOutput) => {
    onHook!({ name: "pre-commit", phase: "start" });
    onOutput!("Native hook output\n", "stderr");
    onHook!({ name: "pre-commit", phase: "exit", exitCode: 0 });
  });
  vi.mocked(git.push).mockImplementation(async (_repo, _remote, _branch, onHook, onOutput) => {
    onHook!({ name: "pre-push", phase: "start" });
    onOutput!("Native push output\n", "stderr");
    onHook!({ name: "pre-push", phase: "exit", exitCode: 0 });
  });

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(log.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  expect(spinner).toHaveBeenCalledTimes(interactive ? 4 : 0);
  for (const [index, result] of vi.mocked(spinner).mock.results.entries()) {
    expect(result.value.start).toHaveBeenCalledTimes(1);
    expect(result.value.stop).toHaveBeenCalledTimes(index === 0 ? 1 : 0);
    expect(result.value.clear).toHaveBeenCalledTimes(index === 0 ? 0 : 1);
  }
  expect(log.step).not.toHaveBeenCalled();
  expect(taskLog).toHaveBeenCalledTimes(3);
  for (const [index, result] of vi.mocked(taskLog).mock.results.entries()) {
    expect(result.value.message).toHaveBeenCalledWith("Running hooks");
    expect(result.value.message).toHaveBeenCalledWith(index === 2 ? "Native push output\n" : "Native hook output\n", { raw: true });
    expect(result.value.success).toHaveBeenCalledTimes(1);
  }
});

it("routes staging, secret-scan and branch-switch diagnostics without displaying internal diffs", async () => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(text).mockResolvedValue("feature/logs");
  vi.mocked(git.stageAll).mockImplementation(async (_repo, onOutput) => onOutput!("stage warning\n", "stderr"));
  vi.mocked(scanStagedChanges).mockImplementation(async (_repo, onOutput) => onOutput!("scan output\n", "stdout"));
  vi.mocked(generateCommitMessage).mockImplementation(async () => {
    const loader = vi.mocked(spinner).mock.results[0]!.value;
    expect(loader.start).toHaveBeenCalledTimes(1);
    expect(loader.clear).not.toHaveBeenCalled();
    expect(loader.stop).not.toHaveBeenCalled();
    expect(taskLog).not.toHaveBeenCalled();
    return "fix: front";
  });
  vi.mocked(git.switchBranch).mockImplementation(async (_repo, _branch, onHook, onOutput) => {
    onHook!({ name: "post-checkout", phase: "start" });
    onOutput!("branch output\n", "stderr");
  });
  await runCommand(commitCommand, { rawArgs: ["--yes", "--no-push"] });
  const messages = vi.mocked(taskLog).mock.results.flatMap(({ value }) => vi.mocked(value.message).mock.calls);
  expect(messages).toEqual([
    ["stage warning\n", { raw: true }], ["scan output\n", { raw: true }],
    ["Running hooks"], ["branch output\n", { raw: true }],
  ]);
  expect(process.exitCode).toBeUndefined();
});

it.each(["", "   ", "feature/new"])("spaces steps once and keeps preparation and review messages together (branch=%j)", async (branch) => {
  vi.mocked(hasGitleaks).mockResolvedValue(false);
  vi.mocked(text).mockResolvedValue(branch);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(log.info).toHaveBeenCalledExactlyOnceWith("Gitleaks not found, skipping secret scan.", { spacing: 0 });
  expect(log.message).toHaveBeenNthCalledWith(1, "(+12 -3) front (main): fix: front", { spacing: 1 });
  expect(log.message).toHaveBeenNthCalledWith(2, "(+12 -3) back (main): fix: back", { spacing: 0 });
  expect(vi.mocked(spinner).mock.calls).toEqual([
    [{ withGuide: true }],
    [{ withGuide: Boolean(branch.trim()) }],
    [{ withGuide: Boolean(branch.trim()) }],
    [{ withGuide: true }],
  ]);
});

it("rejects an invalid hook timeout before preparing repositories", async () => {
  vi.stubEnv("ZD_HOOK_TIMEOUT", "invalid");
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining("ZD_HOOK_TIMEOUT"), { spacing: 0 });
  expect(git.findRepos).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each(["feat", "deps", "feat!", "fix!", "refactor!", "deps!"])("passes the explicit type %s to message generation", async (type) => {
  await runCommand(commitCommand, { rawArgs: ["--yes", "--type", type] });
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/front", expect.any(Object), type);
});

it.each(["FEAT", " feat ", "banana", "", "feat!!", "!feat", "feat(scope)!"])("rejects noncanonical commit types through Citty before staging: %j", async (type) => {
  await expect(runCommand(commitCommand, { rawArgs: ["--yes", "--type", type] })).rejects.toThrow("Invalid value for argument");
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(generateCommitMessage).not.toHaveBeenCalled();
});
