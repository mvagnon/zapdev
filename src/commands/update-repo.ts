import { basename, resolve } from "node:path";

import { defineCommand } from "citty";

import { REPOSITORY_ARGS } from "../config/repository-args";
import { errorMessage } from "../lib/errors";
import { currentBranch, findRepos } from "../lib/git";
import { updateRepository } from "../lib/update-repo";
import { runWorkspaceTask, WORKSPACE_ARGS } from "./workspace-task";

/** Fast-forward the current repository or immediate child repositories without discarding local work. */
export const updateRepoCommand = defineCommand({
  meta: { name: "update-repo", description: "Update branches from their remotes without discarding local changes or commits." },
  args: {
    ...WORKSPACE_ARGS,
    ...REPOSITORY_ARGS,
    branch: { type: "string", description: "Branch to switch to and update; '*' keeps each current branch and also fetches origin. Defaults to each current branch." },
  },
  async run({ args }) {
    await runWorkspaceTask("update-repo", args, async (ui) => {
      const repos = await findRepos(resolve(args.path));
      if (repos.length === 0) throw new Error(`No Git repository found in ${resolve(args.path)} or its immediate children.`);
      const selections: { repo: string; branch: string }[] = [];
      let previousBranchInput = "";
      for (const repo of repos) {
        const current = args.branch ?? await currentBranch(repo);
        previousBranchInput = await ui.input(args.branch, `${basename(repo)} (${current}): branch to update (* = current branch + fetch origin)`, "", previousBranchInput);
        selections.push({ repo, branch: previousBranchInput || current });
      }
      const paths: string[] = [];
      for (const { repo, branch } of selections) {
        try {
          const target = branch === "*" ? "current branch and origin" : branch;
          await ui.task(`${basename(repo)}: updating ${target}`, `${basename(repo)}: ${target} updated`, () => updateRepository(repo, branch));
          paths.push(repo);
        } catch (error) {
          return { paths, error: `${basename(repo)}: ${errorMessage(error)}` };
        }
      }
      return { paths };
    });
  },
});
