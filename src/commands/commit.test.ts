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
  S_BAR_END: "└", S_BAR_START: "┌",
}));

import { confirm, log, select, spinner, text } from "@clack/prompts";
import * as git from "../lib/git";
import { resolveSubtrees } from "../lib/config";
import { GitOutputError } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { commitCommand } from "./commit";
import { reportNativeOutput } from "./native-output";

const repos = ["/repos/front", "/repos/back"];
const subtrees = { "projet-front": "front", "projet-back": "back" };
const hookLogOptions = { secondarySymbol: "", withGuide: false };
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
  const branches = new Map(repos.map((repo) => [repo, "main"]));
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => branches.get(repo) ?? "main");
  vi.mocked(git.switchBranch).mockImplementation(async (repo, branch) => { branches.set(repo, branch); });
  vi.mocked(git.getPushRemote).mockResolvedValue("origin");
  vi.mocked(git.hasUnpushedCommits).mockResolvedValue(true);
  vi.mocked(resolveSubtrees).mockResolvedValue({});
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
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/front");
  expect(scanStagedChanges).toHaveBeenCalledWith("/repos/back");
  expect(git.commit).toHaveBeenCalledWith("/repos/front", "fix: front", expect.any(Function), reportNativeOutput);
  expect(git.commit).toHaveBeenCalledWith("/repos/back", "fix: back", expect.any(Function), reportNativeOutput);
  expect(select).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
}, 1_000);

it.each([false, true])("honors --staged and only sends clean repositories with unpushed commits (pending=%s)", async (pending) => {
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");
  vi.mocked(git.hasUnpushedCommits).mockResolvedValueOnce(true).mockResolvedValueOnce(pending);
  await runCommand(commitCommand, { rawArgs: ["-syp"] });

  expect(git.stageAll).not.toHaveBeenCalled();
  expect(scanStagedChanges).toHaveBeenCalledExactlyOnceWith("/repos/back");
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function), reportNativeOutput);
  expect(git.push).toHaveBeenCalledWith("/repos/back", "origin", "main", expect.any(Function), undefined, reportNativeOutput);
  expect(git.push).toHaveBeenCalledTimes(pending ? 2 : 1);
  expect(vi.mocked(git.push).mock.calls.map(([repo]) => repo)).toEqual(pending ? ["/repos/back", "/repos/front"] : ["/repos/back"]);
  expect(confirm).not.toHaveBeenCalled();
});

it.each([false, true])("sends existing commits without a new commit or LLM call (subtree=%s)", async (subtree) => {
  vi.mocked(git.getStagedDiff).mockResolvedValue("");
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(git.hasUnpushedCommits).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: [] });
  expect(git.commit).not.toHaveBeenCalled();
  expect(generateCommitMessage).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(git.push).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBeUndefined();
});

it.each(["main", "master", "principal", "dev", "development"])("chooses the local branch immediately before committing on %s", async (branch) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(git.currentBranch).mockResolvedValue(branch);
  vi.mocked(text).mockImplementation(async () => {
    expect(git.commit).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(git.hasUnpushedCommits).not.toHaveBeenCalled();
    return "  feature/local  ";
  });
  vi.mocked(select).mockResolvedValue("all");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: `front (${branch}): branch to commit to`, initialValue: "",
  }));
  expect(git.switchBranch).toHaveBeenCalledExactlyOnceWith(repos[0], "feature/local");
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

it("refuses protected-branch commits without a terminal", async () => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;

  await runCommand(commitCommand, { rawArgs: ["-yp"] });

  expect(text).not.toHaveBeenCalled();
  expect(git.commit).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each([false, true])("uses the current branch for cleared input, retaining the previous input default (subtree=%s)", async (subtree) => {
  vi.mocked(git.findRepos).mockResolvedValue([...repos, "/repos/other"]);
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(text).mockResolvedValue("  ").mockResolvedValueOnce("feature/previous");
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialValue: "" }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/previous" }));
  expect(text).toHaveBeenNthCalledWith(3, expect.objectContaining({ initialValue: "" }));
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["feature/previous", "main", "main"]);
  expect(git.switchBranch).toHaveBeenCalledExactlyOnceWith("/repos/front", "feature/previous");
  expect(process.exitCode).toBeUndefined();
});

it.each([false, true])("reuses the previous input across repositories (subtree=%s)", async (subtree) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(text).mockResolvedValueOnce("  feature/shared  ")
    .mockImplementationOnce(async ({ initialValue }) => initialValue!);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ initialValue: "" }));
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/shared" }));
  expect(git.push).toHaveBeenCalledTimes(2);
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["feature/shared", "feature/shared"]);
});

it.each([false, true])("keeps empty inputs empty and sends to each repository's current branch, including main (subtree=%s)", async (subtree) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => repo === repos[0] ? "main" : "dev");
  vi.mocked(text).mockImplementation(async ({ initialValue }) => initialValue!);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(text).toHaveBeenCalledTimes(2);
  for (const [options] of vi.mocked(text).mock.calls) expect(options.initialValue).toBe("");
  expect(vi.mocked(git.push).mock.calls.map((args) => args[2])).toEqual(["main", "dev"]);
  expect(git.switchBranch).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
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
  expect(git.push).toHaveBeenCalledTimes(subtree ? 4 : 2);
});

it.each([false, Symbol("cancel")])("keeps --yes commits local when publication is declined or cancelled: %s", async (answer) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(confirm).mockResolvedValue(answer);
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.push).not.toHaveBeenCalled();
});

it.each([false, true])("never prompts or sends with --yes without a TTY (subtree=%s)", async (subtree) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? subtrees : {});
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");
  await runCommand(commitCommand, { rawArgs: ["-y"] });
  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
});

it("never sends a failed secret scan to the LLM and still processes the other repo", async () => {
  vi.mocked(scanStagedChanges).mockImplementation(async (repo) => {
    if (repo === "/repos/front") throw new Error("Secret detected");
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(generateCommitMessage).toHaveBeenCalledTimes(1);
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/back", expect.any(Object), undefined);
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function), reportNativeOutput);
  expect(process.exitCode).toBe(1);
});

it("edits one repo, then commits only that repo with its edited message", async () => {
  vi.mocked(select)
    .mockImplementationOnce(async ({ options }) => options[4]!.value)
    .mockImplementationOnce(async ({ options }) => options[2]!.value);
  vi.mocked(text).mockResolvedValueOnce("  fix: edited back  ");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: edited back", expect.any(Function), reportNativeOutput);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({
    options: expect.arrayContaining([
      expect.objectContaining({ label: 'Commit only "back (main)"' }),
      expect.objectContaining({ label: 'Edit message for "back (main)"' }),
    ]),
  }));
  expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Edit message for "back (main)"' }));
  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ message: "back (main): branch to commit to" }));
  expect(git.push).not.toHaveBeenCalled();
});

it.each(["color", "pipe", "NO_COLOR"])("shows branches and highlights only pending changes: %s", async (output) => {
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
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "origin", "main", expect.any(Function), undefined, reportNativeOutput);
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
      expect(git.hasUnpushedCommits).toHaveBeenCalledWith(repo, remote, "feature/publish", expect.any(Function), prefix, reportNativeOutput);
      expect(git.push).toHaveBeenCalledWith(repo, remote, "feature/publish", expect.any(Function), prefix, reportNativeOutput);
    }
  }
  expect(git.push).toHaveBeenCalledTimes(4);
  expect(text).not.toHaveBeenCalled();
  expect(git.getPushRemote).not.toHaveBeenCalled();
});

it("asks to publish, reports unchanged subtrees and does not enable automatic publication", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(git.hasUnpushedCommits).mockResolvedValue(false);
  vi.mocked(git.getStagedDiff).mockResolvedValue("");
  await runCommand(commitCommand, { rawArgs: [] });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Publish subtrees in front (main), back (main)?" }));
  expect(git.push).not.toHaveBeenCalled();

  vi.mocked(confirm).mockResolvedValue(true);
  await runCommand(commitCommand, { rawArgs: [] });
  expect(log.info).toHaveBeenCalledWith("front (main): no unpushed commits in projet-front. Skipping.");
  expect(text).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
});

it("stops all publications after a rejection", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.push).mockRejectedValueOnce(new Error("Publication rejected"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  expect(git.push).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledTimes(2);
  expect(log.error).toHaveBeenCalledWith("front (main): publication failed: Publication rejected");
  expect(process.exitCode).toBe(1);
});

it("publishes changed subtrees on the parent's branch and skips unchanged ones without creating branches", async () => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.hasUnpushedCommits).mockResolvedValueOnce(false);
  vi.mocked(text).mockResolvedValueOnce("  feature/shared  ")
    .mockImplementationOnce(async ({ initialValue }) => initialValue!);

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ initialValue: "feature/shared" }));
  expect(vi.mocked(git.push).mock.calls).toEqual([
    ["/repos/front", "back", "feature/shared", expect.any(Function), "projet-back", reportNativeOutput],
    ["/repos/back", "front", "feature/shared", expect.any(Function), "projet-front", reportNativeOutput],
    ["/repos/back", "back", "feature/shared", expect.any(Function), "projet-back", reportNativeOutput],
  ]);
  expect(git.getPushRemote).not.toHaveBeenCalled();
});

it.each([false, true])("checks each actual current branch after committing, without reusing another repo's branch (subtree=%s)", async (subtree) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(git.currentBranch).mockImplementation(async (repo) => repo === repos[0] ? "feature/front" : "fix/api");
  vi.mocked(git.hasUnpushedCommits).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
  const remote = subtree ? "front" : "origin";
  const prefix = subtree ? "projet-front" : undefined;
  expect(git.hasUnpushedCommits).toHaveBeenNthCalledWith(1, "/repos/front", remote, "feature/front", expect.any(Function), prefix, reportNativeOutput);
  expect(git.hasUnpushedCommits).toHaveBeenNthCalledWith(2, "/repos/back", remote, "fix/api", expect.any(Function), prefix, reportNativeOutput);
  expect(text).not.toHaveBeenCalled();
  expect(git.push).toHaveBeenCalledTimes(1);
});

it.each([false, true])("shows the check step after confirmation and before detection (subtree=%s)", async (subtree) => {
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? { "projet-front": "front" } : {});
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(git.hasUnpushedCommits).mockImplementation(async () => {
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(`front (main): checking unpublished commits${subtree ? " in projet-front" : ""} (${subtree ? "front" : "origin"}/main).`);
    expect(text).toHaveBeenCalledTimes(1);
    return false;
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });
  expect(git.hasUnpushedCommits).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBeUndefined();
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
  vi.mocked(git.getStagedDiff).mockResolvedValue("");
  vi.mocked(resolveSubtrees).mockResolvedValue(subtrees);
  vi.mocked(git.currentBranch).mockRejectedValue(new Error("HEAD is not a symbolic ref"));
  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });
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

it("creates the trimmed local branch before committing and pushes it to each resolved remote", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce("upstream").mockResolvedValueOnce("server");
  vi.mocked(text).mockResolvedValueOnce("  feature/front  ").mockResolvedValueOnce("feature/back");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenCalledWith(expect.objectContaining({
    message: "front (main): branch to commit to",
    initialValue: "",
  }));
  expect(git.push).toHaveBeenCalledWith("/repos/front", "upstream", "feature/front", expect.any(Function), undefined, reportNativeOutput);
  expect(git.push).toHaveBeenCalledWith("/repos/back", "server", "feature/back", expect.any(Function), undefined, reportNativeOutput);
  expect(confirm).not.toHaveBeenCalled();
});

it("warns and skips an unresolved remote, then sends the next repo's current branch", async () => {
  vi.mocked(git.getPushRemote).mockResolvedValueOnce(null).mockResolvedValueOnce("server");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledWith("front (main): no remote or ambiguous remote choice. Skipping push; commit remains local.");
  expect(text).toHaveBeenCalledTimes(2);
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back", "server", "main", expect.any(Function), undefined, reportNativeOutput);
  expect(select).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("stops all remaining sends after Git rejects a push", async () => {
  vi.mocked(git.push).mockRejectedValueOnce(new Error("non-fast-forward"));

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(git.push).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

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
  expect(git.commit).toHaveBeenCalledExactlyOnceWith(repos[0], "fix: front", expect.any(Function), reportNativeOutput);
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("does not commit or push a repository whose branch switch failed", async () => {
  vi.mocked(text).mockResolvedValue("feature/shared");
  vi.mocked(git.switchBranch).mockRejectedValueOnce(new Error("Local changes would be overwritten"));
  await runCommand(commitCommand, { rawArgs: ["-yp"] });
  expect(git.commit).toHaveBeenCalledExactlyOnceWith(repos[1], "fix: back", expect.any(Function), reportNativeOutput);
  expect(git.push).toHaveBeenCalledExactlyOnceWith(repos[1], "origin", "feature/shared", expect.any(Function), undefined, reportNativeOutput);
  expect(process.exitCode).toBe(1);
});

it.each([false, true])("allows --push without a terminal on nonprotected branches (subtree=%s)", async (subtree) => {
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  vi.mocked(resolveSubtrees).mockResolvedValue(subtree ? subtrees : {});
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");

  await runCommand(commitCommand, { rawArgs: ["--yes", "--push"] });

  expect(text).not.toHaveBeenCalled();
  expect(git.push).toHaveBeenCalledTimes(subtree ? 4 : 2);
  expect(process.exitCode).toBeUndefined();
});

it.each(["commit", "push", "publication"])("does not repeat native Git diagnostics during %s", async (operation) => {
  vi.mocked(resolveSubtrees).mockResolvedValue(operation === "publication" ? subtrees : {});
  vi.mocked(git.findRepos).mockResolvedValue([repos[0]!]);
  const error = new GitOutputError("Native Git diagnostic");
  if (operation === "commit") vi.mocked(git.commit).mockRejectedValueOnce(error);
  else vi.mocked(git.push).mockRejectedValueOnce(error);

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
  vi.mocked(git.currentBranch).mockResolvedValue("feature/current");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back", expect.any(Function), reportNativeOutput);
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each([true, false])("shows actual hook progress and results with TTY=%s", async (interactive) => {
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  if (!interactive) vi.mocked(git.currentBranch).mockResolvedValue("feature/current");
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

it("passes a valid explicit type to message generation", async () => {
  await runCommand(commitCommand, { rawArgs: ["--yes", "--type", "feat"] });
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/front", expect.any(Object), "feat");
});

it.each(["FEAT", " feat ", "banana", ""])("rejects noncanonical commit types through Citty before staging: %j", async (type) => {
  await expect(runCommand(commitCommand, { rawArgs: ["--yes", "--type", type] })).rejects.toThrow("Invalid value for argument");
  expect(git.stageAll).not.toHaveBeenCalled();
  expect(generateCommitMessage).not.toHaveBeenCalled();
});
