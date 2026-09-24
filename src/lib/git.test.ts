import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

import { findRepos, getStagedDiff, stageAll } from "./git";

const exec = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zapdev-git-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function initRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await exec("git", ["init", "--quiet", path]);
  return path;
}

it("uses the enclosing repo from its root or a subdirectory, ignoring nested repos", async () => {
  await initRepo(root);
  const subdir = join(root, "src");
  await initRepo(join(subdir, "nested"));

  await expect(findRepos(root)).resolves.toEqual([root]);
  await expect(findRepos(subdir)).resolves.toEqual([root]);
});

it("only discovers direct child repos, excluding node_modules and deeper repos", async () => {
  const front = await initRepo(join(root, "front"));
  const back = await initRepo(join(root, "back"));
  await initRepo(join(root, "group", "nested"));
  await initRepo(join(root, "node_modules"));
  await writeFile(join(root, "file.txt"), "not a directory");

  await expect(findRepos(root)).resolves.toEqual([back, front]);
});

it("recognizes repositories whose .git is a file", async () => {
  const repo = join(root, "linked");
  await exec("git", ["init", "--quiet", "--separate-git-dir", join(root, ".metadata"), repo]);

  await expect(findRepos(repo)).resolves.toEqual([repo]);
  await expect(findRepos(root)).resolves.toEqual([repo]);
});

it("returns no repos when none exist at the current or direct child level", async () => {
  await initRepo(join(root, "group", "nested"));
  await expect(findRepos(root)).resolves.toEqual([]);
});

it("stages and reads each repo independently without changing the process directory", async () => {
  const front = await initRepo(join(root, "front"));
  const back = await initRepo(join(root, "back"));
  await writeFile(join(front, "front.txt"), "front change");
  await writeFile(join(back, "back.txt"), "back change");
  const cwd = process.cwd();

  await stageAll(front);
  await expect(getStagedDiff(front)).resolves.toContain("front change");
  await expect(getStagedDiff(back)).resolves.toBe("");
  await stageAll(back);
  const diff = await getStagedDiff(back);
  expect(diff).toContain("back change");
  expect(diff).not.toContain("front change");
  expect(process.cwd()).toBe(cwd);
});
