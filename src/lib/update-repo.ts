import { getPushRemote, git, tryGit } from "./git";
import { repositoryGit } from "./repositories";

/** Update a selected branch from its remote without discarding local work. */
export async function updateRepository(repo: string, branch: string): Promise<void> {
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["check-ref-format", `refs/heads/${branch}`], repo);
  const remote = await getPushRemote(repo, branch);
  if (!remote) throw new Error(`No unambiguous remote configured for ${branch}.`);
  const [upstreamRemote, upstream] = (await git(["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", `refs/heads/${branch}`], repo)).trim().split("\t");
  const remoteRef = upstreamRemote === remote && upstream ? upstream : `refs/heads/${branch}`;
  if (!remoteRef.startsWith("refs/heads/")) throw new Error(`Expected a remote branch, not ${remoteRef}.`);
  const tracking = `refs/remotes/${remote}/${remoteRef.slice("refs/heads/".length)}`;
  await repositoryGit(repo, "fetch", "--no-tags", "--", remote, `${remoteRef}:${tracking}`);
  const head = (await git(["rev-parse", "--verify", `${tracking}^{commit}`], repo)).trim();
  const exists = await tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo) !== null;
  if (!exists) await repositoryGit(repo, "switch", "--no-overwrite-ignore", "--track", "-c", branch, tracking);
  else if ((await tryGit(["symbolic-ref", "--short", "HEAD"], repo))?.trim() !== branch) {
    await repositoryGit(repo, "switch", "--no-overwrite-ignore", "--no-guess", "--", branch);
  }
  await repositoryGit(repo, "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", head);
}
