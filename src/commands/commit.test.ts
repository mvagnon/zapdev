import { basename } from "node:path";
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
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

import { confirm, select, text } from "@clack/prompts";
import * as git from "../lib/git";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { commitCommand } from "./commit";

const repos = ["/repos/front", "/repos/back"];
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ZD_URL", "http://localhost:1234/v1/chat/completions");
  vi.stubEnv("ZD_MODEL", "test-model");
  vi.stubEnv("ZD_EFFORT", "low");
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.exitCode = undefined;
  vi.mocked(git.findRepos).mockResolvedValue(repos);
  vi.mocked(git.getStagedDiff).mockImplementation(async (repo) => repo);
  vi.mocked(git.hasUpstream).mockResolvedValue(true);
  vi.mocked(git.currentBranch).mockResolvedValue("main");
  vi.mocked(hasGitleaks).mockResolvedValue(true);
  vi.mocked(generateCommitMessage).mockImplementation(async (diff) => `fix: ${basename(diff)}`);
  vi.mocked(confirm).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
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
  expect(git.commit).toHaveBeenCalledWith("/repos/front", "fix: front");
  expect(git.commit).toHaveBeenCalledWith("/repos/back", "fix: back");
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
}, 1_000);

it("honors --staged and skips clean repositories when committing and pushing", async () => {
  vi.mocked(git.getStagedDiff).mockResolvedValueOnce("").mockResolvedValueOnce("back");
  await runCommand(commitCommand, { rawArgs: ["-syp"] });

  expect(git.stageAll).not.toHaveBeenCalled();
  expect(scanStagedChanges).toHaveBeenCalledExactlyOnceWith("/repos/back");
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back");
  expect(git.push).toHaveBeenCalledExactlyOnceWith("/repos/back");
  expect(git.fetchRemote).not.toHaveBeenCalled();
});

it("never sends a failed secret scan to the LLM and still processes the other repo", async () => {
  vi.mocked(scanStagedChanges).mockImplementation(async (repo) => {
    if (repo === "/repos/front") throw new Error("Secret detected");
  });
  await runCommand(commitCommand, { rawArgs: ["--yes"] });

  expect(generateCommitMessage).toHaveBeenCalledTimes(1);
  expect(generateCommitMessage).toHaveBeenCalledWith("/repos/back", expect.any(Object), undefined);
  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back");
  expect(process.exitCode).toBe(1);
});

it("edits one repo, then commits only that repo with its edited message", async () => {
  vi.mocked(select)
    .mockImplementationOnce(async ({ options }) => options[4]!.value)
    .mockImplementationOnce(async ({ options }) => options[2]!.value);
  vi.mocked(text).mockResolvedValue("  fix: edited back  ");

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: edited back");
  expect(git.push).not.toHaveBeenCalled();
});

it("accepts all repos and asks once before pushing only the successful commits", async () => {
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(git.commit).mockRejectedValueOnce(new Error("Hook failed"));
  vi.mocked(git.hasUpstream).mockResolvedValue(false);

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(git.pushSetUpstream).toHaveBeenCalledExactlyOnceWith("/repos/back", "main");
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

  expect(git.fetchRemote).toHaveBeenCalledExactlyOnceWith("/repos/front");
  expect(git.pullRebase).toHaveBeenCalledExactlyOnceWith("/repos/front");
  expect(vi.mocked(git.push).mock.calls).toEqual([["/repos/front"], ["/repos/front"], ["/repos/back"]]);
});

it.each(["empty", "error"])("skips a repo whose generation returns %s", async (failure) => {
  if (failure === "empty") vi.mocked(generateCommitMessage).mockResolvedValueOnce("");
  else vi.mocked(generateCommitMessage).mockRejectedValueOnce(new Error("LLM unavailable"));
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;

  await runCommand(commitCommand, { rawArgs: [] });

  expect(git.commit).toHaveBeenCalledExactlyOnceWith("/repos/back", "fix: back");
  expect(select).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
