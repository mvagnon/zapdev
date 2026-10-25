import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { errorMessage } from "./errors";
import { git } from "./git";
import type { WorktreeCleanup } from "../types/git";

type Worktree = { path: string; branch?: string; head?: string; locked: boolean; prunable: boolean };

async function listWorktrees(repo: string): Promise<Worktree[]> {
  const output = await git(["worktree", "list", "--porcelain", "-z"], repo);
  return output.split("\0\0").filter(Boolean).map((record) => {
    const fields = record.split("\0");
    const value = (name: string): string | undefined => fields.find((field) => field.startsWith(`${name} `))?.slice(name.length + 1);
    const path = value("worktree");
    if (!path) throw new Error("Cannot read Git worktree paths safely.");
    return {
      path, branch: value("branch"), head: value("HEAD"),
      locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
    };
  });
}

async function assertOutsideWorktrees(worktrees: Worktree[]): Promise<void> {
  const cwd = await realpath(process.cwd());
  for (const worktree of worktrees) {
    if (worktree.prunable) continue;
    const path = await realpath(worktree.path);
    const fromWorktree = relative(path, cwd);
    if (!isAbsolute(fromWorktree) && fromWorktree !== ".." && !fromWorktree.startsWith(`..${sep}`)) {
      throw new Error(`Run zapdev pr from outside worktree "${worktree.path}" (including its subdirectories) when using --cleanup-worktrees.`);
    }
  }
}

/** Select the branch's linked worktrees, refusing to delete the caller's current directory. */
export async function prepareWorktreeCleanup(repo: string, branch: string): Promise<WorktreeCleanup> {
  const worktrees = await listWorktrees(repo);
  const main = worktrees[0];
  if (!main) throw new Error("Cannot find the main Git worktree for cleanup.");
  const targets = worktrees.slice(1).filter((worktree) => worktree.branch === `refs/heads/${branch}`);
  await assertOutsideWorktrees(targets);
  return { repo: main.path, branch, paths: targets.map(({ path }) => path) };
}

/** Remove selected worktrees without force, preserving changed states and returning warnings for skipped paths. */
export async function cleanupWorktrees(cleanup: WorktreeCleanup, publishedHead: string): Promise<string[]> {
  const worktrees = (await listWorktrees(cleanup.repo)).slice(1);
  await assertOutsideWorktrees(worktrees.filter(({ path }) => cleanup.paths.includes(path)));
  const warnings: string[] = [];
  for (const path of cleanup.paths) {
    const worktree = worktrees.find((worktree) => worktree.path === path);
    let reason: string | undefined;
    if (!worktree || worktree.prunable) reason = "missing or no longer a linked worktree";
    else if (worktree.locked) reason = "locked";
    else if (worktree.branch !== `refs/heads/${cleanup.branch}` || worktree.head !== publishedHead) reason = "branch or HEAD changed since PR preparation";
    else {
      try {
        await git(["worktree", "remove", "--", path], cleanup.repo);
      } catch (error) {
        reason = errorMessage(error);
      }
    }
    if (reason) warnings.push(`Skipped worktree "${path}": ${reason}`);
  }
  return warnings;
}
