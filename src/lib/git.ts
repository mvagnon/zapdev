import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { x } from "tinyexec";

import { resolveHookTimeout } from "./config";
import { GitOutputError } from "./errors";
import { createHookReporter } from "./git-hooks";
import type { DiffStats, HookReporter } from "../types/git";

/** Run Git directly, preserving terminal output and enforcing native hook deadlines. */
export async function git(args: string[], cwd: string, onHook?: HookReporter): Promise<string> {
  const timeout = resolveHookTimeout();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY
    && ["commit", "pull", "push", "fetch", "ls-remote"].includes(args[0] ?? ""));
  const terminalState = interactive && process.platform !== "win32"
    ? execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim()
    : undefined;
  const child = x("git", args, {
    nodeOptions: {
      cwd,
      detached: !interactive && process.platform !== "win32",
      env: { ...process.env, GIT_TRACE2_EVENT: "3" },
      stdio: interactive ? ["inherit", args[0] === "ls-remote" ? "pipe" : "inherit", "inherit", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    },
  });
  let timeoutError: Error | undefined;
  let hookFailureReported = false;
  const { report, close } = createHookReporter((event) => {
    if (onHook && event.phase === "exit" && event.exitCode !== 0) hookFailureReported = true;
    onHook?.(event);
  }, (name) => {
    if (timeoutError || child.pid === undefined) return;
    timeoutError = new Error(`${name} hook timed out after ${timeout / 1_000} seconds`);
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else if (interactive) {
        killProcessTree(child.pid);
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  }, timeout);
  const trace = child.process?.stdio[3];
  const reader = trace instanceof Readable ? createInterface({ input: trace }).on("line", report) : undefined;
  try {
    const result = await child;
    if (timeoutError) throw timeoutError;
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `git ${args.join(" ")} failed`;
      if (interactive) throw new GitOutputError(message, hookFailureReported);
      throw new Error(message);
    }
    return result.stdout;
  } finally {
    reader?.close();
    close();
    if (terminalState) execFileSync("stty", [terminalState], { stdio: ["inherit", "ignore", "ignore"] });
  }
}

function killProcessTree(pid: number): void {
  const children = new Map<number, number[]>();
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  for (const line of output.trim().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const pids = [pid];
  for (const parent of pids) pids.push(...(children.get(parent) ?? []));
  for (const child of pids.reverse()) {
    try {
      process.kill(child, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/** Read optional Git metadata, returning null when Git reports a nonzero exit code. */
export async function tryGit(args: string[], cwd: string): Promise<string | null> {
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

/** Count staged line additions and deletions using Git's machine-readable stats. */
export async function getStagedDiffStats(repo: string): Promise<DiffStats> {
  const output = await git(["diff", "--cached", "--numstat"], repo);
  const stats: DiffStats = { additions: 0, deletions: 0 };
  for (const line of output.trim().split("\n")) {
    const [additions, deletions] = line.split("\t");
    stats.additions += Number(additions) || 0;
    stats.deletions += Number(deletions) || 0;
  }
  return stats;
}

/** Commit the staged changes in the given repository. */
export async function commit(repo: string, message: string, onHook?: HookReporter): Promise<void> {
  await git(["commit", "--quiet", "-m", message], repo, onHook);
}

/** Resolve the current branch, failing for a detached HEAD. */
export async function currentBranch(repo: string): Promise<string> {
  return (await git(["symbolic-ref", "--short", "HEAD"], repo)).trim();
}

/** Switch to an existing local branch or create it from HEAD, preserving pending changes without force. */
export async function switchBranch(repo: string, branch: string): Promise<void> {
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["check-ref-format", `refs/heads/${branch}`], repo);
  const exists = await tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo) !== null;
  await git(exists ? ["switch", "--no-guess", "--", branch] : ["switch", "--no-track", "-c", branch], repo);
}

/** Read the display branch and pending changes, including untracked files. */
export async function getRepoStatus(repo: string): Promise<{ branch: string; hasChanges: boolean }> {
  const lines = (await git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], repo)).trim().split("\n");
  const branch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14) ?? "HEAD";
  return {
    branch: branch === "(detached)" ? "detached HEAD" : branch,
    hasChanges: lines.some((line) => !line.startsWith("#")),
  };
}

/** Resolve the upstream's named remote, or the only configured remote when no upstream exists. */
export async function getPushRemote(repo: string, branch: string): Promise<string | null> {
  const remotes = (await git(["remote"], repo)).trim().split("\n").filter(Boolean);
  const upstream = (await git(["for-each-ref", "--format=%(upstream:remotename)", `refs/heads/${branch}`], repo)).trim();
  if (upstream) return remotes.includes(upstream) ? upstream : null;
  return remotes.length === 1 ? remotes[0]! : null;
}

/** Push committed repository history without force or changes to local branches and upstreams. */
export async function push(repo: string, remote: string, branch: string, onHook?: HookReporter): Promise<void> {
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["push", "--", remote, `HEAD:refs/heads/${branch}`], repo, onHook);
}

/** Check committed history against the current branch's destination, falling back to the remote's default branch. */
export async function hasUnpushedCommits(repo: string, remote: string, branch: string, onHook?: HookReporter): Promise<boolean> {
  if (await tryGit(["rev-parse", "--verify", "HEAD"], repo) === null) return false;
  await git(["check-ref-format", "--branch", branch], repo);
  const ref = `refs/heads/${branch}`;
  const refs = new Set((await git(["ls-remote", "--", remote, ref, "HEAD"], repo, onHook))
    .trim().split("\n").map((line) => line.split("\t")[1]));
  const target = refs.has(ref) ? ref : refs.has("HEAD") ? "HEAD" : null;
  if (!target) return true;
  await git(["fetch", "--quiet", "--", remote, target], repo, onHook);
  return Boolean((await git(["rev-list", "--max-count=1", "FETCH_HEAD..HEAD"], repo)).trim());
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
