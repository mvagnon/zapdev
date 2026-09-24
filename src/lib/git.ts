import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { x } from "tinyexec";

const UPSTREAM_REF = "@{upstream}";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  const result = await x("git", args, { nodeOptions: { cwd } });
  return result.exitCode === 0 ? result.stdout : null;
}

/** Stage all changes in the given repository. */
export async function stageAll(repo: string): Promise<void> {
  await git(["add", "-A"], repo);
}

/** Read the staged diff of the given repository. */
export async function getStagedDiff(repo: string): Promise<string> {
  return git(["diff", "--cached"], repo);
}

/** Commit the staged changes in the given repository. */
export async function commit(repo: string, message: string): Promise<void> {
  await git(["commit", "-m", message], repo);
}

/** Resolve the current branch, failing for a detached HEAD. */
export async function currentBranch(repo: string): Promise<string> {
  return (await git(["symbolic-ref", "--short", "HEAD"], repo)).trim();
}

/** Check whether the current branch tracks an upstream. */
export async function hasUpstream(repo: string): Promise<boolean> {
  const result = await tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", UPSTREAM_REF], repo);
  return result !== null;
}

/** Push the given repository's current branch. */
export async function push(repo: string): Promise<void> {
  await git(["push"], repo);
}

/** Push a branch to origin and configure its upstream. */
export async function pushSetUpstream(repo: string, branch: string): Promise<void> {
  await git(["push", "-u", "origin", branch], repo);
}

/** Rebase the current branch on its upstream. */
export async function pullRebase(repo: string): Promise<void> {
  await git(["pull", "--rebase"], repo);
}

/** Merge the upstream into the current branch. */
export async function pullMerge(repo: string): Promise<void> {
  await git(["pull", "--no-rebase", "--no-edit"], repo);
}

/** Fetch the given repository's remote references. */
export async function fetchRemote(repo: string): Promise<void> {
  await git(["fetch"], repo);
}

/** Count upstream commits missing from HEAD using the last fetched state. */
export async function behindCount(repo: string): Promise<number> {
  const out = await tryGit(["rev-list", "--count", `HEAD..${UPSTREAM_REF}`], repo);
  return out === null ? 0 : Number(out.trim()) || 0;
}

/** Find the enclosing working tree, or only direct child working trees outside a repo. */
export async function findRepos(path: string): Promise<string[]> {
  const root = await repoRoot(path);
  if (root) return [root];

  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules");
  const repos = await Promise.all(dirs.map((entry) => repoRoot(join(path, entry.name))));

  return repos.filter((dir): dir is string => dir !== null).sort();
}

async function repoRoot(dir: string): Promise<string | null> {
  return (await tryGit(["rev-parse", "--show-toplevel"], dir))?.trim() ?? null;
}
