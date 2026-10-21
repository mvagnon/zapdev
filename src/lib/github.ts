import { x } from "tinyexec";

import { currentBranch, getBranchCommits, getPushRemote, git } from "./git";

/** Run GitHub CLI without shell expansion or implicit interactive prompts. */
export async function github(args: string[], repo: string): Promise<string> {
  const result = await x("gh", args, {
    nodeOptions: { cwd: repo, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub CLI failed. Install gh and run gh auth login.");
  return result.stdout.trim();
}

/** Resolve the push repository and fetch the target branch, defaulting to the repository's default. */
export async function getPrContext(repo: string, targetBranch?: string) {
  const branch = await currentBranch(repo);
  const remote = await getPushRemote(repo, branch);
  if (!remote) throw new Error("No unambiguous push remote configured for this branch.");
  const repository = (await git(["remote", "get-url", "--push", remote], repo)).trim();
  const base = targetBranch ?? await github(["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], repo);
  if (!base || (targetBranch === undefined && base === "null")) throw new Error("No target branch found. Set --branch or configure the repository's default branch.");
  await git(["check-ref-format", `refs/heads/${base}`], repo);
  if (branch === base) throw new Error(`Switch to a feature branch before creating a PR into ${base}.`);
  await git(["fetch", "--no-tags", "--", repository, `refs/heads/${base}`], repo);
  const baseCommit = (await git(["rev-parse", "FETCH_HEAD"], repo)).trim();
  const head = (await git(["rev-parse", "HEAD"], repo)).trim();
  const commits = await getBranchCommits(repo, baseCommit);
  if (!commits.length) throw new Error(`No branch-specific commits compared to ${base}.`);
  return { branch, remote, repository, base, head, commits };
}
