import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { x } from "tinyexec";

import { resolveHookTimeout } from "./config";
import { GitOutputError } from "./errors";
import { createHookReporter } from "./git-hooks";
import type { HookReporter } from "../types/git";

async function git(args: string[], cwd: string, onHook?: HookReporter): Promise<string> {
  const timeout = resolveHookTimeout();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && ["commit", "push", "subtree", "fetch"].includes(args[0] ?? ""));
  const terminalState = interactive && process.platform !== "win32"
    ? execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim()
    : undefined;
  const child = x("git", args, {
    nodeOptions: {
      cwd,
      detached: !interactive && process.platform !== "win32",
      env: { ...process.env, GIT_TRACE2_EVENT: "3" },
      stdio: interactive ? ["inherit", "inherit", "inherit", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
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
export async function commit(repo: string, message: string, onHook?: HookReporter): Promise<void> {
  await git(["commit", "--quiet", "-m", message], repo, onHook);
}

/** Resolve the current branch, failing for a detached HEAD. */
export async function currentBranch(repo: string): Promise<string> {
  return (await git(["symbolic-ref", "--short", "HEAD"], repo)).trim();
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

/** Push the requested branch to the selected remote without changing its upstream. */
export async function push(repo: string, remote: string, branch: string, onHook?: HookReporter): Promise<void> {
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["push", "--", remote, branch], repo, onHook);
}

/** Compare committed subtree contents with the remote's main branch. */
export async function hasSubtreeChanges(repo: string, prefix: string, remote: string, onHook?: HookReporter): Promise<boolean> {
  await git(["fetch", "--quiet", remote, "main"], repo, onHook);
  const changes = await git(["diff", "--name-only", "FETCH_HEAD", `HEAD:${prefix}`, "--"], repo);
  return Boolean(changes.trim());
}

/** Push committed subtree contents to the requested branch without force. */
export async function publishSubtree(repo: string, prefix: string, remote: string, branch: string, onHook?: HookReporter): Promise<void> {
  if (branch === "main") throw new Error("Refusing to publish directly to main.");
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["subtree", "push", `--prefix=${prefix}`, remote, branch], repo, onHook);
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
