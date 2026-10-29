import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runProcess } from "./process";
import type { Repository, RepositorySelection } from "../types/repository";

/** Run preparation Git operations without credential prompts or shell interpretation. */
export async function repositoryGit(cwd: string, ...args: string[]): Promise<string> {
  return (await runProcess("git", args, {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  })).stdout.trim();
}

/** Normalize a GitHub repository and reject unsafe checkout/group names. */
export function validateRepository(repo: string, group?: string): { repo: string; group?: string } {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error("Expected a GitHub owner/repo.");
  repo = repo.replace(/\.git$/, "").toLowerCase();
  if (["", ".", ".."].includes(repo.slice(repo.indexOf("/") + 1))) throw new Error("Expected a GitHub owner/repo.");
  group ||= undefined;
  if (group !== undefined && (!/^[^/\\\0]+$/.test(group) || [".", ".."].includes(group))) throw new Error("Expected a group folder name, not a path.");
  return { repo, group };
}

/** Resolve the configured absolute root for disposable checkouts. */
export function repositoryRoot(): string {
  const root = process.env.ZD_REPOS_DIR || join(homedir(), ".zapdev", "repos");
  if (!isAbsolute(root)) throw new Error("ZD_REPOS_DIR must be an absolute path.");
  return root;
}

/** Create a directory, rejecting existing files and symbolic links. */
export function ensureDirectory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`Refusing to use a non-directory or symlink: ${path}`);
  mkdirSync(path, { recursive: true });
}

function requireDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Expected an existing directory, not a symlink: ${path}`);
}

/** Resolve the directory containing branch-named worktree workspaces. */
export function worktreeRoot(): string {
  return join(homedir(), ".zapdev", "worktrees");
}

/** Return a checkout's relative configuration identity, or undefined outside the checkout root. */
export function repositoryRelativePath(root: string, path: string): string | undefined {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`) ? part : undefined;
}

function repositoryPaths(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter(entry => {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") return false;
      const metadata = lstatSync(join(parent, entry.name, ".git"), { throwIfNoEntry: false });
      if (metadata?.isSymbolicLink()) throw new Error(`Refusing symlinked Git metadata: ${join(parent, entry.name)}`);
      return metadata?.isDirectory() || metadata?.isFile();
    })
    .map(entry => join(parent, entry.name)).sort();
}

async function repository(path: string): Promise<Repository> {
  const metadata = lstatSync(join(path, ".git"));
  if (!metadata.isDirectory() && !metadata.isFile()) throw new Error(`Invalid Git metadata: ${path}`);
  if (await repositoryGit(path, "rev-parse", "--show-toplevel") !== path) throw new Error(`Git worktree does not match its path: ${path}`);
  let source = path;
  if (metadata.isFile()) {
    const record = (await repositoryGit(path, "worktree", "list", "--porcelain", "-z")).split("\0", 1)[0];
    if (!record?.startsWith("worktree ")) throw new Error(`Cannot identify the source repository: ${path}`);
    source = record.slice("worktree ".length);
    requireDirectory(source);
    source = realpathSync(source);
  }
  return { path, source };
}

/** Resolve an enclosing Git repository or immediate children, retaining source identities for configuration. */
export async function selectRepositories(path = process.cwd()): Promise<RepositorySelection> {
  requireDirectory(resolve(path));
  const target = realpathSync(path);
  const configuredRoot = repositoryRoot();
  const root = lstatSync(configuredRoot, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(configuredRoot) : resolve(configuredRoot);
  for (let ancestor = target; ; ancestor = dirname(ancestor)) {
    if (lstatSync(join(ancestor, ".git"), { throwIfNoEntry: false })) {
      const selected = await repository(ancestor);
      return { ...selected, root, isRepository: true, repositories: [selected] };
    }
    if (ancestor === dirname(ancestor)) break;
  }
  const repositories = await Promise.all(repositoryPaths(target).map(repository));
  let source: string | undefined = target;
  if (repositories.some(repository => repository.path !== repository.source)) {
    const parents = new Set(repositories.map(({ source }) => dirname(source)));
    const [parent] = parents;
    source = parents.size === 1 ? parent : undefined;
  }
  return { root, path: target, source, isRepository: false, repositories };
}
