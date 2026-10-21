import { cancel, confirm, intro, isCancel, note, outro } from "@clack/prompts";
import { defineCommand } from "citty";

import { LLM_ARGS } from "../config/llm-args";
import { resolveConfig, resolveHookTimeout } from "../lib/config";
import { currentBranch, getRepoStatus, git, push } from "../lib/git";
import { getPrContext, github } from "../lib/github";
import { generatePrTitle } from "../lib/llm";
import { buildPrDescription, validateClosesUrl } from "../lib/pr";
import { runTask } from "./git-task";
import { reportError } from "./report-error";

/** Generate and review a PR title and deterministic changelog before publishing the current branch. */
export const prCommand = defineCommand({
  meta: { name: "pr", description: "Create a GitHub PR with an AI title and a deterministic Conventional Commit description." },
  args: {
    ...LLM_ARGS,
    closes: { type: "string", alias: "c", description: "URL of the PM task closed by this PR." },
    branch: { type: "string", alias: "b", description: "Target branch of the PR; defaults to the repository's default branch." },
    yes: { type: "boolean", alias: "y", description: "Push the branch and create the PR without confirmation." },
  },
  async run({ args }) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    try {
      const closes = validateClosesUrl(args.closes);
      const config = resolveConfig(process.env, args);
      resolveHookTimeout();
      const repo = (await git(["rev-parse", "--show-toplevel"], process.cwd())).trim();
      if ((await getRepoStatus(repo)).hasChanges) {
        throw new Error("Cannot create a PR with uncommitted changes (staged, unstaged or untracked files). Commit or stash them, then run zapdev pr again.");
      }
      if (interactive) intro("zapdev pr");
      const context = await runTask("Reading branch commits", "Branch commits ready", () => getPrContext(repo, args.branch));
      const title = await runTask("Generating PR title", "PR title generated", () => generatePrTitle(context.commits, config));
      const body = buildPrDescription(context.commits, closes);
      note(`${title}\n\n${body}`, `${context.branch} → ${context.base}`);
      if (interactive && !args.yes) {
        const answer = await confirm({ message: "Push this branch and create the PR?", initialValue: true });
        if (isCancel(answer) || !answer) {
          cancel("Cancelled. Nothing pushed or created.");
          return;
        }
      }
      if (await currentBranch(repo) !== context.branch || (await git(["rev-parse", "HEAD"], repo)).trim() !== context.head) {
        throw new Error("The branch changed during review. Run zapdev pr again.");
      }
      await runTask("Pushing branch", "Branch pushed", (onOutput, onHook) =>
        push(repo, context.remote, context.branch, onHook, onOutput));
      const url = await runTask("Creating PR", "PR created", () => github([
        "pr", "create", "--repo", context.repository, "--base", context.base,
        "--head", context.branch, "--title", title, "--body", body,
      ], repo));
      outro(url);
    } catch (error) {
      reportError(error);
    }
  },
});
