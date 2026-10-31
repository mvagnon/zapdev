import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { runProcess } from "./process";
import { ensureDirectory, repositoryGit as git, repositoryRoot, selectRepositories, validateRepository } from "./repositories";
import { resolveConfigs, resolveResources } from "./workspace-config";
import type { RepositorySelection } from "../types/repository";

type Secret = { source: string; name: string };

function readSecrets(source: string, recursive: boolean): Secret[] | undefined {
  const files: Secret[] = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.name.toLowerCase() === ".git") throw new Error(`Refusing to link Git metadata from secrets: ${from}`);
    if (entry.isDirectory()) {
      if (recursive) files.push(...(readSecrets(from, true) ?? []).map(file => ({ ...file, name: join(entry.name, file.name) })));
    } else {
      if (!entry.isFile()) throw new Error(`Refusing to link a non-file or symlink from secrets: ${from}`);
      files.push({ source: from, name: entry.name });
    }
  }
  return files.length === 0 ? undefined : files;
}

/** Resolve secret files with optional exclusive repository/parent or group/children fallback. */
export function resolveSecrets(selection: RepositorySelection, allowFallback = true): { path: string; value: Secret[] }[] {
  return resolveResources(selection, "secrets", readSecrets, allowFallback);
}

/** Link selected secrets, then execute preparation commands in their selected scope. */
export async function prepareCheckouts(selection: RepositorySelection, allowFallback = true): Promise<void> {
  for (const { path, value } of resolveSecrets(selection, allowFallback)) {
    for (const { source, name } of value) {
      const destination = join(path, name);
      let parent = path;
      ensureDirectory(parent);
      for (const part of dirname(name).split(sep)) {
        parent = join(parent, part);
        ensureDirectory(parent);
      }
      const target = lstatSync(destination, { throwIfNoEntry: false });
      if (target?.isSymbolicLink() && readlinkSync(destination) === source) continue;
      if (target && !target.isFile()) throw new Error(`Refusing to overwrite a non-file or symlink: ${destination}`);
      if (target) rmSync(destination);
      symlinkSync(source, destination);
    }
  }
  for (const { path: cwd, value } of resolveConfigs(selection, allowFallback)) {
    if (value.prepareCommand !== undefined) await runProcess("/bin/sh", ["-c", value.prepareCommand], { cwd });
  }
}

/** Clone/reset one explicitly selected disposable GitHub checkout, then prepare its resources. */
export async function prepareSelection(input: { repo: string; group?: string; branch?: string }): Promise<{ path: string }> {
  const { repo, group } = validateRepository(input.repo, input.group);
  let { branch } = input;
  const home = homedir();
  if (branch) await git(home, "check-ref-format", "--branch", branch);
  const root = repositoryRoot();
  const parent = group === undefined ? root : join(root, group);
  const checkoutName = repo.replace("/", "__");
  const path = join(parent, checkoutName);
  const directories = process.env.ZD_REPOS_DIR ? [root, parent] : [join(home, ".zapdev"), root, parent];
  for (const directory of directories) ensureDirectory(directory);
  const lock = join(parent, `.${checkoutName}.lock`);
  mkdirSync(lock);
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isDirectory() || !lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Refusing to overwrite a non-checkout path: ${path}`);
      if ((await git(path, "rev-parse", "--show-toplevel")) !== realpathSync(path)) throw new Error(`Checkout worktree does not match its path: ${path}`);
      const remote = (await git(path, "config", "--get", "remote.origin.url")).replace(/\.git$/, "").toLowerCase();
      if (![ `https://github.com/${repo}`, `git@github.com:${repo}`, `ssh://git@github.com/${repo}` ].includes(remote)) throw new Error(`Checkout remote does not match ${repo}: ${path}`);
      await git(path, "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");
    } else {
      mkdirSync(path);
      try {
        await git(parent, "clone", "--quiet", "--filter=blob:none", `https://github.com/${repo}.git`, path);
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
    }
    if (!branch) {
      await git(path, "remote", "set-head", "origin", "--auto");
      branch = (await git(path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")).slice("refs/remotes/origin/".length);
    }
    const reference = `refs/remotes/origin/${branch}`;
    await git(path, "rev-parse", "--verify", `${reference}^{commit}`);
    await git(path, "checkout", "--quiet", "--force", "-B", branch, reference);
    await git(path, "clean", "--quiet", "-fd");
    const selection = await selectRepositories(path);
    if (group !== undefined) {
      await prepareCheckouts({ ...selection, path: parent, source: parent, isRepository: false, repositories: [] }, false);
    }
    await prepareCheckouts(selection, false);
    return { path };
  } finally {
    rmdirSync(lock);
  }
}
