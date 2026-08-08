import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { x } from "tinyexec";

import type { Worktree } from "../types/worktree";
import { parseBranches, parseDefaultBranch } from "./branches";
import { parseWorktrees } from "./worktrees";

const UPSTREAM_REF = "@{upstream}";
const BRANCH_FORMAT = "%(refname:short)";

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function tryGit(args: string[], cwd?: string): Promise<string | null> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  return result.exitCode === 0 ? result.stdout : null;
}

export async function stageAll(): Promise<void> {
  await git(["add", "-A"]);
}

export async function getStagedDiff(): Promise<string> {
  return git(["diff", "--cached"]);
}

export async function commit(message: string): Promise<void> {
  await git(["commit", "-m", message]);
}

export async function currentBranch(): Promise<string> {
  return (await git(["symbolic-ref", "--short", "HEAD"])).trim();
}

export async function hasUpstream(): Promise<boolean> {
  const result = await tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", UPSTREAM_REF]);
  return result !== null;
}

export async function push(): Promise<void> {
  await git(["push"]);
}

export async function pushSetUpstream(branch: string): Promise<void> {
  await git(["push", "-u", "origin", branch]);
}

export async function pullRebase(): Promise<void> {
  await git(["pull", "--rebase"]);
}

export async function pullMerge(): Promise<void> {
  await git(["pull", "--no-rebase", "--no-edit"]);
}

export async function fetchRemote(): Promise<void> {
  await git(["fetch"]);
}

// Commits on the upstream not yet in HEAD. Zero when there is no upstream.
// Reflects the last fetched state, so fetch first for an up-to-date count.
export async function behindCount(): Promise<number> {
  const out = await tryGit(["rev-list", "--count", `HEAD..${UPSTREAM_REF}`]);
  return out === null ? 0 : Number(out.trim()) || 0;
}

// If `path` is itself a repo, reset operates on it alone; otherwise its direct
// child repos (level 1, non-recursive). Never recurses into a repo.
export async function findRepos(path: string): Promise<string[]> {
  if (await isGitRepo(path)) return [path];

  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules");
  const repos = await Promise.all(
    dirs.map(async (entry) => {
      const dir = join(path, entry.name);
      return (await isGitRepo(dir)) ? dir : null;
    }),
  );

  return repos.filter((dir): dir is string => dir !== null).sort();
}

// A main working tree has `.git` as a directory; a linked worktree has it as a
// file, so requiring a directory excludes worktrees that live under the parent.
async function isGitRepo(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  return entries?.some((entry) => entry.name === ".git" && entry.isDirectory()) ?? false;
}

export async function fetchPrune(repo: string): Promise<void> {
  await git(["fetch", "--prune"], repo);
}

export async function defaultBranch(repo: string): Promise<string | null> {
  const output = await tryGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    repo,
  );
  return output === null ? null : parseDefaultBranch(output);
}

export async function currentBranchAt(repo: string): Promise<string | null> {
  const output = await tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
  return output === null ? null : output.trim();
}

export async function localBranches(repo: string): Promise<string[]> {
  return parseBranches(await git(["branch", `--format=${BRANCH_FORMAT}`], repo));
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const local = await tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  if (local !== null) return true;
  const remote = await tryGit(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    repo,
  );
  return remote !== null;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  return parseWorktrees(await git(["worktree", "list", "--porcelain"], repo));
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(["worktree", "remove", "--force", path], repo);
}

export async function switchBranch(repo: string, branch: string): Promise<void> {
  await git(["switch", branch], repo);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(["branch", "-D", branch], repo);
}

export async function pull(repo: string): Promise<void> {
  await git(["pull"], repo);
}
