import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

import { commit, findRepos, getRepoStatus, getStagedDiff, push, stageAll } from "./git";
import type { HookEvent } from "../types/git";

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

it("reports branches and pending changes for unborn, staged, unstaged and detached states", async () => {
  await initRepo(root);
  await exec("git", ["symbolic-ref", "HEAD", "refs/heads/feature/status"], { cwd: root });
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "feature/status", hasChanges: false });

  const file = join(root, "file.txt");
  await writeFile(file, "new file");
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "feature/status", hasChanges: true });
  await stageAll(root);
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "feature/status", hasChanges: true });

  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: root });
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "feature/status", hasChanges: false });
  await writeFile(file, "modified file");
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "feature/status", hasChanges: true });

  await exec("git", ["checkout", "--detach", "--quiet", "HEAD"], { cwd: root });
  await expect(getRepoStatus(root)).resolves.toEqual({ branch: "detached HEAD", hasChanges: true });
});

async function configureHooks(): Promise<string> {
  await initRepo(root);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.hooksPath", "hooks"]] as const) {
    await exec("git", ["config", key, value], { cwd: root });
  }
  await writeFile(join(root, "file.txt"), "change");
  await stageAll(root);
  const hooks = join(root, "hooks");
  await mkdir(hooks);
  return hooks;
}

it.each([0, 3])("observes live commit hooks and preserves their failure output (exit %s)", async (exitCode) => {
  const hooks = await configureHooks();
  const preCommit = join(hooks, "pre-commit");
  await writeFile(preCommit, `#!/bin/sh
git rev-parse --git-dir >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  test -f hook-observed && exit 0
  sleep 0.05
done
echo 'Hook was not observed live' >&2
exit 9
`);
  const commitMsg = join(hooks, "commit-msg");
  await writeFile(commitMsg, `#!/bin/sh\necho 'commit-msg diagnostic' >&2\nexit ${exitCode}\n`);
  await chmod(preCommit, 0o755);
  await chmod(commitMsg, 0o755);
  await writeFile(join(hooks, "prepare-commit-msg"), "#!/bin/sh\nexit 8\n", { mode: 0o644 });
  const events: HookEvent[] = [];

  const result = commit(root, "fix: hooks", (event) => {
    events.push(event);
    if (event.name === "pre-commit" && event.phase === "start") writeFileSync(join(root, "hook-observed"), "observed");
  });
  if (exitCode === 0) await result;
  else await expect(result).rejects.toThrow("commit-msg diagnostic");

  expect(events).toEqual([
    { name: "pre-commit", phase: "start" },
    { name: "pre-commit", phase: "exit", exitCode: 0 },
    { name: "commit-msg", phase: "start" },
    { name: "commit-msg", phase: "exit", exitCode },
  ]);
});

it("does not report hooks disabled by Git", async () => {
  const hooks = await configureHooks();
  await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 8\n", { mode: 0o755 });
  await exec("git", ["config", "core.hooksPath", "/dev/null"], { cwd: root });
  const events: HookEvent[] = [];

  await commit(root, "fix: no hooks", (event) => events.push(event));

  expect(events).toEqual([]);
});

it("reports an actual pre-push hook and its exit code", async () => {
  const hooks = await configureHooks();
  await commit(root, "fix: initial");
  const remote = join(root, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", remote]);
  await exec("git", ["remote", "add", "origin", remote], { cwd: root });
  await exec("git", ["config", "push.default", "current"], { cwd: root });
  await writeFile(join(hooks, "pre-push"), "#!/bin/sh\necho 'pre-push diagnostic' >&2\nexit 5\n", { mode: 0o755 });
  const events: HookEvent[] = [];

  await expect(push(root, (event) => events.push(event))).rejects.toThrow("pre-push diagnostic");

  expect(events).toEqual([
    { name: "pre-push", phase: "start" },
    { name: "pre-push", phase: "exit", exitCode: 5 },
  ]);
});
