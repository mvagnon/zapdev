import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "./errors";
import { git } from "./git";
import { worktreeRoot } from "./repositories";
import type { WorktreeCleanup, WorktreeCleanupResult } from "../types/git";

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

/** Select the branch's linked worktrees for cleanup. */
export async function prepareWorktreeCleanup(repo: string, branch: string): Promise<WorktreeCleanup> {
  const worktrees = await listWorktrees(repo);
  const main = worktrees[0];
  if (!main) throw new Error("Cannot find the main Git worktree for cleanup.");
  const targets = worktrees.slice(1).filter((worktree) => worktree.branch === `refs/heads/${branch}`);
  return { repo: main.path, branch, paths: targets.map(({ path }) => path) };
}

/** Remove selected worktrees without force, reporting actual deletions and reasons for skipped paths. */
export async function cleanupWorktrees(cleanup: WorktreeCleanup, publishedHead: string): Promise<WorktreeCleanupResult> {
  const worktrees = (await listWorktrees(cleanup.repo)).slice(1);
  const result: WorktreeCleanupResult = { deletedWorktrees: [], skippedWorktrees: [] };
  for (const path of cleanup.paths) {
    const worktree = worktrees.find((worktree) => worktree.path === path);
    let reason: string | undefined;
    if (!worktree || worktree.prunable) reason = "missing or no longer a linked worktree";
    else if (worktree.locked) reason = "locked";
    else if (worktree.branch !== `refs/heads/${cleanup.branch}` || worktree.head !== publishedHead) reason = "branch or HEAD changed since PR preparation";
    else {
      try {
        await git(["worktree", "remove", "--", path], cleanup.repo);
        result.deletedWorktrees.push(path);
        const workspace = dirname(path);
        if (workspace === join(worktreeRoot(), cleanup.branch.replaceAll("/", "__")) &&
          lstatSync(workspace, { throwIfNoEntry: false })?.isDirectory() && realpathSync(workspace) === workspace) {
          const entries = readdirSync(workspace, { withFileTypes: true });
          if (entries.every(entry => entry.isSymbolicLink())) {
            for (const entry of entries) unlinkSync(join(workspace, entry.name));
            rmdirSync(workspace);
          }
        }
      } catch (error) {
        reason = result.deletedWorktrees.includes(path)
          ? `Worktree removed, but parent cleanup failed: ${errorMessage(error)}`
          : errorMessage(error);
      }
    }
    if (reason) result.skippedWorktrees.push({ path, reason });
  }
  return result;
}
