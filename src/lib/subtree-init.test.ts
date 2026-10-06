import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resolveSubtrees } from "./config";
import { git, hasSubtreeChanges } from "./git";
import { initializeSubtrees, parseSubtreeSources } from "./subtree-init";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zapdev-subtree-init-"));
  const config = join(root, "gitconfig");
  await writeFile(config, "[user]\nname = Test\nemail = test@example.com\n[commit]\ngpgsign = false\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("ZD_HOOK_TIMEOUT", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function source(name: string, branch = "main"): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory);
  await git(["init", "--quiet", "-b", branch], directory);
  await writeFile(join(directory, "file.txt"), name);
  await git(["add", "."], directory);
  await git(["commit", "--quiet", "-m", "initial"], directory);
  return directory;
}

it("parses named sources without splitting equals signs inside URLs", () => {
  expect(parseSubtreeSources(["front=https://host/repo?token=a=b", "back=git@host:back.git"])).toEqual([
    { name: "front", url: "https://host/repo?token=a=b" },
    { name: "back", url: "git@host:back.git" },
  ]);
});

it.each([
  { entries: [] }, { entries: ["front"] }, { entries: ["front="] },
  { entries: ["=url"] }, { entries: ["../front=url"] }, { entries: ["-front=url"] },
  { entries: ["zapdev.json=url"] }, { entries: ["front=--all"] },
  { entries: ["front=one", "front=two"] },
])("rejects invalid sources before initialization: $entries", ({ entries }) => {
  expect(() => parseSubtreeSources(entries)).toThrow();
});

it("initializes named remotes, imports their default branches and commits the new mapping", async () => {
  const front = await source("source-front", "master");
  const back = await source("source-back", "release");
  const repo = join(root, "project");
  const origin = join(root, "origin.git");

  await initializeSubtrees(repo, parseSubtreeSources([`front=${front}`, `back=${back}`]), { origin });

  expect(await readFile(join(repo, "front", "file.txt"), "utf8")).toBe("source-front");
  expect(await readFile(join(repo, "back", "file.txt"), "utf8")).toBe("source-back");
  await expect(resolveSubtrees(repo)).resolves.toEqual({ front: "front", back: "back" });
  expect((await git(["remote", "get-url", "origin"], repo)).trim()).toBe(origin);
  expect((await git(["remote", "get-url", "front"], repo)).trim()).toBe(front);
  expect((await git(["branch", "--show-current"], repo)).trim()).toBe("main");
  expect(await git(["status", "--porcelain"], repo)).toBe("");
  await expect(hasSubtreeChanges(repo, "front", "front")).resolves.toBe(false);
  await expect(hasSubtreeChanges(repo, "back", "back")).resolves.toBe(false);
}, 15_000);

it("extends an existing mapping without overwriting other configuration or switching branches", async () => {
  const url = await source("source");
  const repo = join(root, "project");
  await mkdir(repo);
  await git(["init", "--quiet", "-b", "feature/existing"], repo);
  await writeFile(join(repo, "zapdev.json"), JSON.stringify({ custom: "keep", subtrees: { existing: "old" } }));
  await git(["add", "."], repo);
  await git(["commit", "--quiet", "-m", "initial"], repo);
  await git(["remote", "add", "front", url], repo);

  await initializeSubtrees(repo, parseSubtreeSources([`front=${url}`]));

  expect(JSON.parse(await readFile(join(repo, "zapdev.json"), "utf8"))).toEqual({
    custom: "keep", subtrees: { existing: "old", front: "front" },
  });
  expect((await git(["branch", "--show-current"], repo)).trim()).toBe("feature/existing");
  expect(await git(["status", "--porcelain"], repo)).toBe("");
});

it("falls back to main with a warning when the remote HEAD has no symbolic branch", async () => {
  const url = await source("source");
  await git(["checkout", "--quiet", "--detach"], url);
  const onWarning = vi.fn();

  await initializeSubtrees(join(root, "project"), parseSubtreeSources([`front=${url}`]), { onWarning });

  expect(onWarning).toHaveBeenCalledExactlyOnceWith("Could not detect default branch for front; using main.");
});

it.each(["dirty", "prefix", "symlink", "remote", "origin", "config-symlink"])("refuses %s conflicts before importing any subtree", async (conflict) => {
  const url = await source("source");
  const repo = join(root, "project");
  await mkdir(repo);
  await git(["init", "--quiet", "-b", "main"], repo);
  if (conflict === "config-symlink") {
    await writeFile(join(root, "external.json"), '{"subtrees":{}}');
    await symlink(join(root, "external.json"), join(repo, "zapdev.json"));
  } else await writeFile(join(repo, "zapdev.json"), '{"subtrees":{}}');
  if (conflict === "prefix") await writeFile(join(repo, "back"), "existing file");
  if (conflict === "symlink") await symlink("missing", join(repo, "back"));
  await git(["add", "."], repo);
  await git(["commit", "--quiet", "-m", "initial"], repo);
  if (conflict === "dirty") await writeFile(join(repo, "untracked.txt"), "keep me");
  if (conflict === "remote" || conflict === "origin") {
    await git(["remote", "add", conflict === "remote" ? "back" : "origin", "other-url"], repo);
  }
  const head = await git(["rev-parse", "HEAD"], repo);

  await expect(initializeSubtrees(repo, parseSubtreeSources([`front=${url}`, `back=${url}`]), {
    origin: conflict === "origin" ? url : undefined,
  })).rejects.toThrow(conflict === "dirty" ? "clean" : conflict === "prefix" || conflict === "symlink" ? "already exists" : conflict === "config-symlink" ? "symbolic link" : "another URL");

  expect(await git(["rev-parse", "HEAD"], repo)).toBe(head);
  expect(await git(["remote"], repo)).not.toContain("front");
  expect(await readFile(join(repo, "zapdev.json"), "utf8")).toBe('{"subtrees":{}}');
});
