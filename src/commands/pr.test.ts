import { confirm } from "@clack/prompts";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  confirm: vi.fn(), intro: vi.fn(), note: vi.fn(), outro: vi.fn(),
}));
vi.mock("../lib/git");
vi.mock("../lib/github");
vi.mock("../lib/llm", () => ({ generatePrTitle: vi.fn() }));
vi.mock("./git-task");
vi.mock("./report-error");

import { currentBranch, getRepoStatus, git, push } from "../lib/git";
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
