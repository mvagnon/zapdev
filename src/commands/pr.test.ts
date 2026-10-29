import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { confirm, intro, log, note, outro, select } from "@clack/prompts";
import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  cancel: vi.fn(), confirm: vi.fn(), intro: vi.fn(), note: vi.fn(), outro: vi.fn(), select: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { warn: vi.fn(), success: vi.fn() },
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
const exitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  process.exitCode = exitCode;
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

it.each([[], ["--non-interactive"], ["--yes"], ["-y"], ["--no-yes"]])("only skips terminal confirmation when requested (%j)", async (...rawArgs: string[]) => {
  await runCommand(prCommand, { rawArgs });

  expect(confirm).toHaveBeenCalledTimes(rawArgs.some((arg) => ["--non-interactive", "--yes", "-y"].includes(arg)) ? 0 : 1);
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

it.each([undefined, "../other repo", "/absolute/repo"])("discovers repositories from the optional path without cleanup: %s", async (path) => {
  const cwd = process.cwd();

  await runCommand(prCommand, { rawArgs: [...(path ? [path] : []), "--yes"] });

  expect(findRepos).toHaveBeenCalledExactlyOnceWith(resolve(path ?? cwd));
  expect(git).not.toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"], expect.any(String));
  expect(push).toHaveBeenCalledTimes(1);
  expect(process.cwd()).toBe(cwd);
});

it.each(["", "src"])("allows cleanup from a targeted worktree or its subdirectory: %s", async (subdir) => {
  const cwd = await realpath(process.cwd());
  const path = subdir ? dirname(cwd) : cwd;
  vi.mocked(git).mockImplementation(async (args) => args[0] === "worktree"
    ? `worktree ${dirname(path)}\0HEAD base-sha\0branch refs/heads/main\0\0worktree ${path}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0`
    : "head-sha");

  await runCommand(prCommand, { rawArgs: ["--yes", "--cleanup-worktrees"] });

  expect(reportError).not.toHaveBeenCalled();
  expect(push).toHaveBeenCalledTimes(1);
  expect(github).toHaveBeenCalledTimes(1);
  expect(git).toHaveBeenCalledWith(["worktree", "remove", "--", path], dirname(path));
});

it("allows cleanup in every selected repository when one targets the current directory", async () => {
  const cwd = await realpath(process.cwd());
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(git).mockImplementation(async (args, repo) => {
    if (args[0] !== "worktree") return "head-sha";
    const back = repo === "/repos/back" || repo === dirname(cwd);
    return `worktree ${back ? dirname(cwd) : join(cwd, "front-main")}\0HEAD base-sha\0branch refs/heads/main\0\0worktree ${back ? cwd : join(cwd, "src")}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0`;
  });

  await runCommand(prCommand, { rawArgs: ["--yes", "--cleanup-worktrees"] });

  expect(reportError).not.toHaveBeenCalled();
  expect(push).toHaveBeenCalledTimes(2);
  expect(github).toHaveBeenCalledTimes(2);
  expect(git).toHaveBeenCalledWith(["worktree", "remove", "--", join(cwd, "src")], join(cwd, "front-main"));
  expect(git).toHaveBeenCalledWith(["worktree", "remove", "--", cwd], dirname(cwd));
});

it.each([false, true])("only removes matching linked worktrees after successful PR creation (creation fails=%s)", async (fails) => {
  const main = await realpath(process.cwd());
  const path = join(main, "src");
  const other = join(main, "src", "types");
  const detached = join(main, "src", "lib");
  const listing = `worktree ${main}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0worktree ${path}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0worktree ${other}\0HEAD other-sha\0branch refs/heads/feature/pr-other\0\0worktree ${detached}\0HEAD head-sha\0detached\0\0`;
  vi.mocked(findRepos).mockResolvedValue([path]);
  vi.mocked(git).mockImplementation(async (args) => {
    if (args[0] === "worktree" && args[1] === "list") return listing;
    if (args[0] === "worktree" && args[1] === "remove") {
      expect(github).toHaveBeenCalledTimes(1);
      return "";
    }
    return "head-sha";
  });
  if (fails) vi.mocked(github).mockRejectedValueOnce(new Error("PR creation failed"));

  await runCommand(prCommand, { rawArgs: ["--yes", "--cleanup-worktrees"] });

  const removals = vi.mocked(git).mock.calls.filter(([args]) => args[0] === "worktree" && args[1] === "remove");
  expect(removals).toEqual(fails ? [] : [[["worktree", "remove", "--", path], main]]);
  if (!fails) {
    expect(reportError).not.toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledExactlyOnceWith(`Deleted worktree: ${JSON.stringify(path)}`);
  } else expect(log.success).not.toHaveBeenCalled();
});

it("preserves locked, missing, changed and dirty worktrees, continuing cleanup without force", async () => {
  const main = await realpath(process.cwd());
  const paths = ["src", "src/lib", "src/types", "src/config", "src/prompts"].map((path) => join(main, path));
  const listing = (changed: boolean): string => `worktree ${main}\0HEAD base-sha\0branch refs/heads/main\0\0${paths.map((path, index) =>
    `worktree ${path}\0HEAD ${changed && index === 2 ? "new-sha" : "head-sha"}\0branch refs/heads/feature/pr\0${index === 0 ? "locked reason\0" : index === 1 ? "prunable missing\0" : ""}\0`).join("")}`;
  let lists = 0;
  vi.mocked(git).mockImplementation(async (args) => {
    if (args[0] === "worktree" && args[1] === "list") return listing(lists++ > 0);
    if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === paths[3]) throw new Error("contains modified or untracked files");
    return "head-sha";
  });

  await runCommand(prCommand, { rawArgs: ["--yes", "--cleanup-worktrees"] });

  const removals = vi.mocked(git).mock.calls.filter(([args]) => args[0] === "worktree" && args[1] === "remove");
  expect(removals).toEqual(paths.slice(3).map((path) => [["worktree", "remove", "--", path], main]));
  expect(log.warn).toHaveBeenCalledTimes(4);
  expect(log.success).toHaveBeenCalledExactlyOnceWith(`Deleted worktree: ${JSON.stringify(paths[4])}`);
  expect(reportError).not.toHaveBeenCalled();
});

it.each([false, true])("emits only structured PR and cleanup results on stdout with --json (TTY=%s)", async (interactive) => {
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const main = await realpath(process.cwd());
  const removed = join(main, "src");
  const skipped = join(main, "src", "types");
  vi.mocked(git).mockImplementation(async (args) => {
    if (args[0] === "worktree" && args[1] === "list") return `worktree ${main}\0HEAD base-sha\0branch refs/heads/main\0\0worktree ${removed}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0worktree ${skipped}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0`;
    if (args[0] === "worktree" && args.at(-1) === skipped) throw new Error("contains untracked files");
    return "head-sha";
  });
  vi.mocked(push).mockImplementation(async (_repo, _remote, _branch, _onHook, onOutput) => {
    onOutput!("Native Git diagnostic\n", "stdout");
  });

  await runCommand(prCommand, { rawArgs: ["--json", "--yes", "--cleanup-worktrees"] });

  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ pullRequests: [{
    repo: "/repo", branch: "feature/pr", url: "https://github.com/owner/repo/pull/1",
    deletedWorktrees: [removed], skippedWorktrees: [{ path: skipped, reason: "contains untracked files" }],
  }] })}\n`);
  expect(stderr).toHaveBeenCalledWith("Native Git diagnostic\n");
  for (const output of [intro, note, outro, confirm, select, runTask, log.warn, log.success, reportError]) expect(output).not.toHaveBeenCalled();
});

it.each([[], ["--cleanup-worktrees"]])("returns empty cleanup arrays in JSON when nothing is deleted (%j)", async (...flags: string[]) => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.mocked(git).mockImplementation(async (args) => args[0] === "worktree"
    ? `worktree ${process.cwd()}\0HEAD head-sha\0branch refs/heads/feature/pr\0\0`
    : "head-sha");

  await runCommand(prCommand, { rawArgs: ["--json", "--yes", ...flags] });

  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ pullRequests: [{
    repo: "/repo", branch: "feature/pr", url: "https://github.com/owner/repo/pull/1", deletedWorktrees: [], skippedWorktrees: [],
  }] })}\n`);
});

it("emits an empty JSON result without human output when no repository is found", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.mocked(findRepos).mockResolvedValue([]);

  await runCommand(prCommand, { rawArgs: ["--json", "--yes"] });

  expect(stdout).toHaveBeenCalledExactlyOnceWith('{"pullRequests":[]}\n');
  expect(log.warn).not.toHaveBeenCalled();
});

it("preserves created PRs in JSON and returns failure when a later PR fails", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.mocked(findRepos).mockResolvedValue(["/repos/front", "/repos/back"]);
  vi.mocked(github).mockResolvedValueOnce("https://github.com/owner/front/pull/1").mockRejectedValueOnce(new Error("creation failed"));

  await runCommand(prCommand, { rawArgs: ["--json", "--yes"] });

  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ pullRequests: [{
    repo: "/repos/front", branch: "feature/pr", url: "https://github.com/owner/front/pull/1", deletedWorktrees: [], skippedWorktrees: [],
  }], error: "back: creation failed" })}\n`);
  expect(process.exitCode).toBe(1);
  expect(reportError).not.toHaveBeenCalled();
});

it("requires explicit confirmation for JSON output in a terminal without printing prompts", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  await runCommand(prCommand, { rawArgs: ["--json"] });

  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ pullRequests: [], error: "Use --non-interactive with --json in a terminal to confirm PR creation." })}\n`);
  expect(findRepos).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it.each([false, true])("cleans real worktree directories even when cwd points inside through a symlink (inside=%s)", async (inside) => {
  const actual = await vi.importActual<typeof import("../lib/git")>("../lib/git");
  const root = await realpath(await mkdtemp(join(tmpdir(), "zapdev-worktrees-")));
  try {
    const main = join(root, "main");
    const clean = join(root, "clean space\nworktree");
    const second = join(root, "second");
    const dirty = join(root, "dirty");
    const locked = join(root, "locked");
    await actual.git(["init", "--quiet", "-b", "main", main], root);
    await actual.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], main);
    await actual.git(["worktree", "add", "-b", "feature/pr", clean], main);
    for (const path of [second, dirty, locked]) await actual.git(["worktree", "add", "--force", path, "feature/pr"], main);
    await actual.git(["worktree", "lock", locked], main);
    await writeFile(join(dirty, "untracked.txt"), "keep me");
    await mkdir(join(clean, "nested"));
    await symlink(clean, join(root, "alias"));
    const head = (await actual.git(["rev-parse", "HEAD"], clean)).trim();
    vi.mocked(getPrContext).mockResolvedValue({ branch: "feature/pr", base: "main", remote: "origin", repository: "owner/repo", head, commits: ["feat: search"] });
    vi.mocked(findRepos).mockResolvedValue([clean]);
    vi.mocked(git).mockImplementation((args, repo) => actual.git(args, repo));
    if (inside) vi.spyOn(process, "cwd").mockReturnValue(join(root, "alias", "nested"));

    await runCommand(prCommand, { rawArgs: [clean, "--yes", "--cleanup-worktrees"] });

    await expect(access(clean)).rejects.toThrow();
    await expect(access(second)).rejects.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
    for (const path of [main, dirty, locked]) await expect(access(path)).resolves.toBeUndefined();
    expect((await actual.git(["show-ref", "--verify", "refs/heads/feature/pr"], main)).trim()).toContain(head);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
