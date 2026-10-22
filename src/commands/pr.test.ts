import { confirm, log, select } from "@clack/prompts";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  cancel: vi.fn(), confirm: vi.fn(), intro: vi.fn(), note: vi.fn(), outro: vi.fn(), select: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { warn: vi.fn() },
}));
vi.mock("../lib/git");
vi.mock("../lib/github");
vi.mock("../lib/llm", () => ({ generatePrTitle: vi.fn() }));
vi.mock("./git-task");
vi.mock("./report-error");

import { currentBranch, findRepos, getRepoStatus, git, push } from "../lib/git";
import { getPrContext, github } from "../lib/github";
import { generatePrTitle } from "../lib/llm";
import { runTask } from "./git-task";
import { prCommand } from "./pr";
import { reportError } from "./report-error";

const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
});

beforeEach(() => {
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  vi.stubEnv("ZD_URL", "http://localhost:1234/v1/chat/completions");
  vi.stubEnv("ZD_MODEL", "test-model");
  vi.stubEnv("ZD_EFFORT", "low");
  vi.stubEnv("ZD_HOOK_TIMEOUT", undefined);
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(select).mockResolvedValue("all");
  vi.mocked(findRepos).mockResolvedValue(["/repo"]);
  vi.mocked(git).mockImplementation(async (args) => args[0] === "rev-parse" && args[1] === "HEAD" ? "head-sha" : "/repo");
  vi.mocked(currentBranch).mockResolvedValue("feature/pr");
  vi.mocked(getRepoStatus).mockResolvedValue({ branch: "feature/pr", hasChanges: false });
  vi.mocked(getPrContext).mockResolvedValue({
    branch: "feature/pr", base: "main", remote: "origin", repository: "owner/repo",
    head: "head-sha", commits: ["feat: search"],
  });
  vi.mocked(generatePrTitle).mockResolvedValue("feat: search");
  vi.mocked(github).mockResolvedValue("https://github.com/owner/repo/pull/1");
  vi.mocked(runTask).mockImplementation(async (_title, _success, run) => run(vi.fn(), vi.fn()));
});

it.each([[], ["--yes"], ["-y"], ["--no-yes"]])("only skips terminal confirmation when yes is enabled (%j)", async (...rawArgs: string[]) => {
  await runCommand(prCommand, { rawArgs });

  expect(confirm).toHaveBeenCalledTimes(rawArgs.includes("--yes") || rawArgs.includes("-y") ? 0 : 1);
  expect(push).toHaveBeenCalledExactlyOnceWith("/repo", "origin", "feature/pr", expect.any(Function), expect.any(Function));
  expect(github).toHaveBeenCalledExactlyOnceWith([
    "pr", "create", "--repo", "owner/repo", "--base", "main", "--head", "feature/pr",
    "--title", "feat: search", "--body", "### Features\n\n- search",
  ], "/repo");
});

it.each([
  { interactive: true, rawArgs: [] },
  { interactive: true, rawArgs: ["--yes"] },
  { interactive: false, rawArgs: [] },
])("rejects uncommitted changes before reading commits, generating a title or publishing ($interactive, $rawArgs)", async ({ interactive, rawArgs }) => {
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  vi.mocked(getRepoStatus).mockResolvedValue({ branch: "feature/pr", hasChanges: true });

  await runCommand(prCommand, { rawArgs });

  expect(reportError).toHaveBeenCalledExactlyOnceWith(new Error(
    "Cannot create a PR with uncommitted changes (staged, unstaged or untracked files). Commit or stash them, then run zapdev pr again.",
  ));
  expect(getPrContext).not.toHaveBeenCalled();
  expect(generatePrTitle).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
});

it("does nothing when no repository is found", async () => {
  vi.mocked(findRepos).mockResolvedValue([]);

  await runCommand(prCommand, { rawArgs: [] });

  expect(findRepos).toHaveBeenCalledExactlyOnceWith(process.cwd());
  expect(log.warn).toHaveBeenCalledWith("No git repository found here or in direct children.");
  expect(getPrContext).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalled();
});

it.each([[], ["--yes"], ["--branch", "develop"]])("prepares every child repo before publishing with its own context (%j)", async (...rawArgs: string[]) => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(getPrContext).mockImplementation(async (repo, base) => ({
    branch: "feature/pr", base: base ?? (repo.endsWith("front") ? "main" : "develop"),
    remote: repo.endsWith("front") ? "origin" : "upstream", repository: `owner/${repo.split("/").at(-1)}`,
    head: "head-sha", commits: [repo.endsWith("front") ? "feat: search" : "fix: api"],
  }));
  vi.mocked(generatePrTitle).mockImplementation(async (commits) => commits[0]!);
  vi.mocked(push).mockImplementation(async () => {
    expect(generatePrTitle).toHaveBeenCalledTimes(2);
  });

  await runCommand(prCommand, { rawArgs });

  expect(getPrContext).toHaveBeenCalledWith("/repos/front", rawArgs.includes("--branch") ? "develop" : undefined);
  expect(getPrContext).toHaveBeenCalledWith("/repos/back", rawArgs.includes("--branch") ? "develop" : undefined);
  expect(select).toHaveBeenCalledTimes(rawArgs.includes("--yes") ? 0 : 1);
  expect(confirm).not.toHaveBeenCalled();
  expect(push).toHaveBeenNthCalledWith(1, "/repos/front", "origin", "feature/pr", expect.any(Function), expect.any(Function));
  expect(push).toHaveBeenNthCalledWith(2, "/repos/back", "upstream", "feature/pr", expect.any(Function), expect.any(Function));
  expect(github).toHaveBeenCalledWith([
    "pr", "create", "--repo", "owner/back", "--base", "develop", "--head", "feature/pr",
    "--title", "fix: api", "--body", "### Bug Fixes\n\n- api",
  ], "/repos/back");
  expect(reportError).not.toHaveBeenCalled();
});

it("can publish only one child repository", async () => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(select).mockResolvedValue("/repos/back");

  await runCommand(prCommand, { rawArgs: [] });

  expect(push).toHaveBeenCalledExactlyOnceWith("/repos/back", "origin", "feature/pr", expect.any(Function), expect.any(Function));
  expect(github).toHaveBeenCalledTimes(1);
  expect(github).toHaveBeenCalledWith(expect.any(Array), "/repos/back");
});

it.each(["cancel", Symbol("cancel")])("does not publish when multi-repo review is cancelled (%s)", async (answer) => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(select).mockResolvedValue(answer);

  await runCommand(prCommand, { rawArgs: [] });

  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
});

it("does not prepare or publish any PR when a child repository has uncommitted changes", async () => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(getRepoStatus).mockImplementation(async (repo) => ({ branch: "feature/pr", hasChanges: repo.endsWith("back") }));

  await runCommand(prCommand, { rawArgs: [] });

  expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("back:") }));
  expect(getPrContext).not.toHaveBeenCalled();
  expect(generatePrTitle).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
});

it("does not publish any PR when preparing a child repository fails", async () => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(getPrContext).mockRejectedValueOnce(new Error("No branch-specific commits compared to main."));

  await runCommand(prCommand, { rawArgs: [] });

  expect(reportError).toHaveBeenCalledWith(new Error("front: No branch-specific commits compared to main."));
  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
});

it("checks all selected branches before pushing any repository", async () => {
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(currentBranch).mockImplementation(async (repo) => repo.endsWith("back") ? "other" : "feature/pr");

  await runCommand(prCommand, { rawArgs: [] });

  expect(reportError).toHaveBeenCalledWith(new Error("back: The branch changed during review. Run zapdev pr again."));
  expect(push).not.toHaveBeenCalled();
  expect(github).not.toHaveBeenCalled();
});
