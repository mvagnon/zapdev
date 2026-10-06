import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { x } from "tinyexec";

import { commit, currentBranch, findRepos, getPushRemote, getRepoStatus, getStagedDiff, git, hasUnpushedCommits, push, stageAll, switchBranch } from "./git";
import type { HookEvent } from "../types/git";

const exec = promisify(execFile);
let root: string;

beforeEach(async () => {
  vi.stubEnv("ZD_HOOK_TIMEOUT", undefined);
  root = await realpath(await mkdtemp(join(tmpdir(), "zapdev-git-")));
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

it("creates or switches local branches while preserving staged changes and the original branch", async () => {
  await configureHooks();
  await commit(root, "chore: initial");
  const original = await currentBranch(root);
  const before = await git(["rev-parse", "HEAD"], root);
  await writeFile(join(root, "file.txt"), "pending change");
  await stageAll(root);

  await switchBranch(root, "feature/local");
  await expect(currentBranch(root)).resolves.toBe("feature/local");
  await expect(getStagedDiff(root)).resolves.toContain("pending change");
  await expect(git(["rev-parse", original], root)).resolves.toBe(before);
  await switchBranch(root, original);
  await expect(currentBranch(root)).resolves.toBe(original);
  await expect(getStagedDiff(root)).resolves.toContain("pending change");
  for (const branch of ["--force", "invalid..branch", "@{-1}"]) {
    await expect(switchBranch(root, branch)).rejects.toThrow();
    await expect(currentBranch(root)).resolves.toBe(original);
  }
});

it("creates an unborn branch without losing staged changes", async () => {
  await configureHooks();
  await switchBranch(root, "feature/initial");
  await expect(currentBranch(root)).resolves.toBe("feature/initial");
  await expect(getStagedDiff(root)).resolves.toContain("change");
});

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

it("interrupts a hanging hook and its subprocesses using the configured deadline without a reporter", async () => {
  const hooks = await configureHooks();
  vi.stubEnv("ZD_HOOK_TIMEOUT", "0.05");
  await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });

  await expect(commit(root, "fix: timeout")).rejects.toThrow("pre-commit hook timed out after 0.05 seconds");
  await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root })).rejects.toThrow();
  await stageAll(root);
}, 2_000);

it.skipIf(process.platform !== "darwin").each(["answer", "timeout", "failure", "silent-failure"])("supports real terminal hook logs and prompts: %s", async (mode) => {
  const hooks = await configureHooks();
  await writeFile(join(hooks, "pre-commit"), `#!/bin/sh
test -t 1 && test -t 2 || exit 7
stty -echo </dev/tty
printf 'HOOK_LOG\nContinue? [y/n] ' >/dev/tty
read answer </dev/tty
printf 'HOOK_ANSWER=%s\n' "$answer" >/dev/tty
if test "$answer" != y; then
  ${mode === "silent-failure" ? "" : "echo 'HOOK_DIAGNOSTIC' >&2"}
  exit 3
fi
`, { mode: 0o755 });
  const program = `
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
const jiti = createJiti(import.meta.url);
const { commit, getStagedDiff } = await jiti.import(${JSON.stringify(new URL("./git.ts", import.meta.url).href)});
const { GitOutputError } = await jiti.import(${JSON.stringify(new URL("./errors.ts", import.meta.url).href)});
const terminalState = () => execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" });
const initialState = terminalState();
if (!(await getStagedDiff(${JSON.stringify(root)})).includes("change")) throw new Error("Diff was not captured");
try {
  await commit(${JSON.stringify(root)}, "fix: interactive", ${JSON.stringify(mode)} === "failure" ? (event) => {
    if (event.phase === "exit" && event.exitCode !== 0) console.log("HOOK_FAILURE_STATUS");
   } : undefined, (phase) => console.log("NATIVE_" + phase));
  console.log("INTERACTIVE_DONE");
} catch (error) {
  if (${JSON.stringify(mode)} === "timeout") {
    if (error instanceof GitOutputError || !error.message.includes("timed out after 0.2 seconds")) throw error;
    console.log("TIMEOUT_OK");
  } else if (["failure", "silent-failure"].includes(${JSON.stringify(mode)})) {
    if (!(error instanceof GitOutputError) || error.hookFailureReported !== (${JSON.stringify(mode)} === "failure")) throw error;
    console.log("NATIVE_FAILURE_OK");
  } else throw error;
} finally {
  console.log("TERMINAL_DONE");
  if (terminalState() !== initialState) throw new Error("Terminal state was not restored");
}
`;
  const terminal = x("sh", ["-c", 'cat | script -q /dev/null "$@"', "sh", process.execPath, "--input-type=module", "-e", program], {
    nodeOptions: { env: { ...process.env, ZD_HOOK_TIMEOUT: mode === "timeout" ? "0.2" : "60" } },
  });
  let output = "";
  let answered = false;
  terminal.process?.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
    if (mode !== "timeout" && !answered && output.includes("Continue? [y/n]")) {
      answered = true;
      terminal.process?.stdin?.write(mode === "answer" ? "y\n" : "n\n");
    }
    if (output.includes("TERMINAL_DONE")) terminal.process?.stdin?.end();
  });
  const result = await terminal;
  expect(result.stderr).toBe("");
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toContain("HOOK_LOG");
  expect(result.stdout.match(/NATIVE_start/g)).toHaveLength(1);
  expect(result.stdout.match(/NATIVE_exit/g)).toHaveLength(1);
  expect(result.stdout.indexOf("NATIVE_start")).toBeLessThan(result.stdout.indexOf("HOOK_LOG"));
  expect(result.stdout.indexOf("NATIVE_exit")).toBeGreaterThan(result.stdout.indexOf("HOOK_LOG"));
  expect(result.stdout).toContain(mode === "answer" ? "HOOK_ANSWER=y" : mode === "timeout" ? "TIMEOUT_OK" : "NATIVE_FAILURE_OK");
  if (mode === "failure") expect(result.stdout.match(/HOOK_DIAGNOSTIC/g)).toHaveLength(1);
  if (mode === "silent-failure") expect(result.stdout).not.toContain("HOOK_DIAGNOSTIC");
  if (mode === "answer") {
    expect(result.stdout).toContain("INTERACTIVE_DONE");
    expect(result.stdout).not.toContain("fix: interactive");
    expect(result.stdout).not.toMatch(/\d+ files? changed/);
  }
}, 5_000);

it("reports an actual pre-push hook and its exit code", async () => {
  const hooks = await configureHooks();
  await commit(root, "fix: initial");
  const remote = join(root, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", remote]);
  await exec("git", ["remote", "add", "origin", remote], { cwd: root });
  const { stdout: branch } = await exec("git", ["branch", "--show-current"], { cwd: root });
  await writeFile(join(hooks, "pre-push"), "#!/bin/sh\necho 'pre-push diagnostic' >&2\nexit 5\n", { mode: 0o755 });
  const events: HookEvent[] = [];

  await expect(push(root, "origin", branch.trim(), (event) => events.push(event))).rejects.toThrow("pre-push diagnostic");

  expect(events).toEqual([
    { name: "pre-push", phase: "start" },
    { name: "pre-push", phase: "exit", exitCode: 5 },
  ]);
});

async function initSubtrees(): Promise<void> {
  await configureHooks();
  await commit(root, "chore: initial");
  await exec("git", ["checkout", "--quiet", "-b", "feature/publish"], { cwd: root });
  for (const remote of ["front", "back"]) {
    const source = await initRepo(join(root, `source-${remote}`));
    const branch = remote === "front" ? "main" : "master";
    await exec("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: source });
    await writeFile(join(source, "file.txt"), remote);
    await stageAll(source);
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: source });
    await exec("git", ["remote", "add", remote, source], { cwd: root });
    await exec("git", ["subtree", "add", `--prefix=packages/${remote}`, remote, branch, "--squash"], { cwd: root });
  }
}

it("publishes only committed subtree contents, skips unchanged subtrees and preserves hooks", async () => {
  await initSubtrees();
  await writeFile(join(root, "packages", "front", "file.txt"), "published change");
  await exec("git", ["add", "packages/front/file.txt"], { cwd: root });
  await commit(root, "feat: front change");
  await writeFile(join(root, "packages", "front", "file.txt"), "uncommitted change");
  await writeFile(join(root, "hooks", "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const events: HookEvent[] = [];

  await expect(hasUnpushedCommits(root, "front", "main", undefined, "packages/front")).resolves.toBe(true);
  await expect(hasUnpushedCommits(root, "back", "master", undefined, "packages/back")).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "front", "feature/new", undefined, "packages/front")).resolves.toBe(true);
  await expect(hasUnpushedCommits(root, "back", "feature/new", undefined, "packages/back")).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "missing-remote", "main", undefined, "packages/front")).rejects.toThrow();
  await push(root, "front", "feature/destination", (event) => events.push(event), "packages/front");
  const source = join(root, "source-front");
  const published = await exec("git", ["show", "feature/destination:file.txt"], { cwd: source });
  expect(published.stdout).toBe("published change");
  const files = await exec("git", ["ls-tree", "--name-only", "feature/destination"], { cwd: source });
  expect(files.stdout.trim()).toBe("file.txt");
  await expect(exec("git", ["rev-parse", "--verify", "feature/destination"], { cwd: join(root, "source-back") })).rejects.toThrow();
  expect(events).toContainEqual({ name: "pre-push", phase: "exit", exitCode: 0 });
  await expect(hasUnpushedCommits(root, "front", "feature/destination", undefined, "packages/front")).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "front", "main", undefined, "packages/front")).resolves.toBe(true);

  await exec("git", ["checkout", "--quiet", "feature/destination"], { cwd: source });
  await writeFile(join(source, "file.txt"), "remote-only change");
  await stageAll(source);
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "diverging change"], { cwd: source });
  const beforePush = await exec("git", ["rev-parse", "feature/destination"], { cwd: source });
  await exec("git", ["checkout", "--quiet", "main"], { cwd: source });
  await expect(push(root, "front", "feature/destination", undefined, "packages/front")).rejects.toThrow();
  const remoteHead = await exec("git", ["rev-parse", "feature/destination"], { cwd: source });
  expect(remoteHead.stdout).toBe(beforePush.stdout);
}, 15_000);

it("captures the split commit ID even when running in a terminal", async () => {
  await initSubtrees();
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;
  try {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const source = (await git(["subtree", "split", "--prefix=packages/front", "--quiet", "HEAD"], root)).trim();
    expect(source).toMatch(/^[a-f0-9]{40,64}$/);
    expect(await git(["show", `${source}:file.txt`], root)).toBe("front");
  } finally {
    process.stdin.isTTY = stdinTTY;
    process.stdout.isTTY = stdoutTTY;
  }
}, 15_000);

it.each([false, true])("allows pushing to main (subtree=%s)", async (subtree) => {
  await initSubtrees();
  await writeFile(join(root, "packages", "front", "file.txt"), "main change");
  await stageAll(root);
  await commit(root, "feat: main change");
  const remote = join(root, "main.git");
  await exec("git", ["init", "--quiet", "--bare", remote]);
  await git(["remote", "add", "destination", remote], root);
  await push(root, "destination", "main", undefined, subtree ? "packages/front" : undefined);
  const path = subtree ? "file.txt" : "packages/front/file.txt";
  expect(await git(["show", `main:${path}`], remote)).toBe("main change");
}, 15_000);

it("refuses invalid branch names before publication", async () => {
  await initRepo(root);
  await expect(push(root, "front", "invalid..branch", undefined, "packages/front")).rejects.toThrow("valid branch");
});

it("pushes HEAD to a new destination without changing local branches or their upstream", async () => {
  await configureHooks();
  await commit(root, "fix: initial");
  const origin = join(root, "origin.git");
  const other = join(root, "other.git");
  for (const [name, path] of [["origin", origin], ["other", other]] as const) {
    await exec("git", ["init", "--quiet", "--bare", path]);
    await exec("git", ["remote", "add", name, path], { cwd: root });
  }
  await exec("git", ["checkout", "--quiet", "-b", "feature/input"], { cwd: root });
  await exec("git", ["push", "--quiet", "-u", "origin", "feature/input"], { cwd: root });
  await exec("git", ["checkout", "--quiet", "-b", "feature/current"], { cwd: root });
  await writeFile(join(root, "file.txt"), "current branch change");
  await stageAll(root);
  await commit(root, "feat: current");

  await push(root, "other", "feature/destination");

  const local = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  const remote = await exec("git", ["rev-parse", "feature/destination"], { cwd: other });
  expect(remote.stdout).toBe(local.stdout);
  const upstream = await exec("git", ["rev-parse", "--symbolic-full-name", "feature/input@{upstream}"], { cwd: root });
  expect(upstream.stdout.trim()).toBe("refs/remotes/origin/feature/input");
  await expect(exec("git", ["rev-parse", "--verify", "refs/heads/feature/destination"], { cwd: root })).rejects.toThrow();
  await expect(exec("git", ["rev-parse", "--verify", "feature/current"], { cwd: other })).rejects.toThrow();
});

it("detects unpushed commits against the requested remote branch, ignoring upstream names and stale refs", async () => {
  await configureHooks();
  await commit(root, "fix: initial");
  const remote = join(root, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", remote]);
  await git(["remote", "add", "origin", remote], root);
  const branch = await currentBranch(root);
  await expect(hasUnpushedCommits(root, "origin", branch)).resolves.toBe(true);
  await push(root, "origin", branch);
  await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], remote);
  await expect(hasUnpushedCommits(root, "origin", branch)).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "origin", "feature/new")).resolves.toBe(false);
  await git(["checkout", "--quiet", "-b", "feature/local", "--track", `origin/${branch}`], root);
  await writeFile(join(root, "file.txt"), "pending change");
  await git(["add", "file.txt"], root);
  await commit(root, "feat: pending");
  await expect(hasUnpushedCommits(root, "origin", "feature/local")).resolves.toBe(true);
  await push(root, "origin", branch);
  await expect(hasUnpushedCommits(root, "origin", branch)).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "origin", "feature/local")).resolves.toBe(false);
  await git(["update-ref", "-d", `refs/heads/${branch}`], remote);
  await expect(hasUnpushedCommits(root, "origin", branch)).resolves.toBe(true);
});

it("has no commits to push in an unborn repository", async () => {
  await initRepo(root);
  await expect(hasUnpushedCommits(root, "origin", "main")).resolves.toBe(false);
  await expect(hasUnpushedCommits(root, "front", "main", undefined, "packages/front")).resolves.toBe(false);
});

it.each(["", "--force", "invalid..branch", "main:other"])("rejects invalid push input before sending: %s", async (branch) => {
  await initRepo(root);
  await expect(push(root, "origin", branch)).rejects.toThrow();
});

it.each([{ remotes: [] }, { remotes: ["server"] }, { remotes: ["origin", "server"] }])("resolves only an unambiguous remote without an upstream: $remotes", async ({ remotes }) => {
  await initRepo(root);
  for (const remote of remotes) await exec("git", ["remote", "add", remote, join(root, `${remote}.git`)], { cwd: root });

  await expect(getPushRemote(root, "feature/current")).resolves.toBe(remotes.length === 1 ? remotes[0] : null);
});

it("prefers the current branch's upstream remote even when its tracking ref is missing", async () => {
  await configureHooks();
  await commit(root, "fix: initial");
  await exec("git", ["checkout", "--quiet", "-b", "feature/current"], { cwd: root });
  for (const remote of ["origin", "team/server"]) {
    await exec("git", ["remote", "add", remote, join(root, "remote.git")], { cwd: root });
  }
  await exec("git", ["config", "branch.feature/current.remote", "team/server"], { cwd: root });
  await exec("git", ["config", "branch.feature/current.merge", "refs/heads/main"], { cwd: root });
  await exec("git", ["config", "branch.feature/current.pushRemote", "origin"], { cwd: root });

  await expect(getPushRemote(root, "feature/current")).resolves.toBe("team/server");

  await exec("git", ["config", "branch.feature/current.remote", "."], { cwd: root });
  await expect(getPushRemote(root, "feature/current")).resolves.toBeNull();
});
