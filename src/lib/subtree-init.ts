import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readProjectConfig } from "./config";
import { commit, getRepoStatus, getStagedDiff, git, tryGit } from "./git";
import type { SubtreeSource } from "../types/subtree";
import type { NativeOutputReporter } from "../types/git";

/** Parse unique name=url sources, keeping equals signs inside repository URLs. */
export function parseSubtreeSources(entries: string[]): SubtreeSource[] {
  if (entries.length === 0) throw new Error("Provide at least one subtree as name=url.");
  const names = new Set<string>();
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    const url = entry.slice(separator + 1);
    if (separator < 1 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name)
      || name === "zapdev.json" || name.includes("..") || name.endsWith(".") || name.endsWith(".lock")
      || !url.trim() || url.startsWith("-") || url.includes("\0")) {
      throw new Error(`Invalid source "${entry}": expected name=url with a simple folder and remote name.`);
    }
    if (names.has(name)) throw new Error(`Duplicate subtree name "${name}".`);
    names.add(name);
    return { name, url };
  });
}

/** Initialize or extend a clean repository, import squashed subtrees and commit their explicit mapping. */
export async function initializeSubtrees(
  directory: string,
  sources: SubtreeSource[],
  options: { origin?: string; onProgress?: (message: string) => void; onWarning?: (message: string) => void; onNativeOutput?: NativeOutputReporter } = {},
): Promise<void> {
  if (!directory.trim()) throw new Error("Directory cannot be empty.");
  if (options.origin !== undefined && (!options.origin.trim() || options.origin.startsWith("-") || options.origin.includes("\0"))) {
    throw new Error("--origin must be a nonempty repository URL.");
  }
  const repo = resolve(directory);
  await mkdir(repo, { recursive: true });
  if (!await exists(join(repo, ".git"))) await git(["init", "--quiet", "-b", "main"], repo);
  if ((await getRepoStatus(repo)).hasChanges) {
    throw new Error("Working tree must be clean before adding subtrees (including untracked files).");
  }

  const configPath = join(repo, "zapdev.json");
  if (await exists(configPath) && (await lstat(configPath)).isSymbolicLink()) {
    throw new Error("Refusing to overwrite zapdev.json through a symbolic link.");
  }
  const settings = await readProjectConfig(repo);
  const mapping = new Map(Object.entries(settings.subtrees ?? {}));
  const remotes = new Map<string, string>();
  if (options.origin !== undefined) remotes.set("origin", options.origin);
  for (const { name, url } of sources) {
    if (await exists(join(repo, name))) throw new Error(`"${name}" already exists.`);
    const mappedRemote = mapping.get(name);
    if (mappedRemote && mappedRemote !== name) throw new Error(`"${name}" is already mapped to remote "${mappedRemote}".`);
    const plannedURL = remotes.get(name);
    if (plannedURL && plannedURL !== url) throw new Error(`Remote "${name}" was requested with another URL: ${plannedURL}`);
    remotes.set(name, url);
  }
  const missingRemotes: [string, string][] = [];
  for (const [name, url] of remotes) {
    const existingURL = await tryGit(["remote", "get-url", name], repo);
    if (existingURL === null) missingRemotes.push([name, url]);
    else if (existingURL.trim() !== url) throw new Error(`Remote "${name}" already exists with another URL: ${existingURL.trim()}`);
  }

  const imports: (SubtreeSource & { branch: string })[] = [];
  for (const source of sources) {
    options.onProgress?.(`Detecting default branch for ${source.name}`);
    const refs = await git(["ls-remote", "--symref", "--", source.url, "HEAD"], repo, undefined, options.onNativeOutput);
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(refs)?.[1];
    if (!branch) options.onWarning?.(`Could not detect default branch for ${source.name}; using main.`);
    imports.push({ ...source, branch: branch ?? "main" });
  }

  const initial = await tryGit(["rev-parse", "--verify", "HEAD"], repo) === null;
  for (const { name } of sources) mapping.set(name, name);
  await writeFile(configPath, `${JSON.stringify({ ...settings, subtrees: Object.fromEntries(mapping) }, null, 2)}\n`);
  await git(["add", "--", "zapdev.json"], repo);
  if (initial || (await getStagedDiff(repo)).trim()) {
    await commit(repo, initial ? "chore: init" : "chore: configure subtrees", undefined, options.onNativeOutput);
  }
  for (const [name, url] of missingRemotes) await git(["remote", "add", name, url], repo);
  for (const { name, branch } of imports) {
    options.onProgress?.(`Adding ${name} (${branch})`);
    await git(["subtree", "add", `--prefix=${name}`, name, branch, "--squash"], repo, undefined, options.onNativeOutput);
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
