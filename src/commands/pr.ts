import { basename, resolve } from "node:path";

import { cancel, confirm, intro, isCancel, log, note, outro, select } from "@clack/prompts";
import { defineCommand } from "citty";

import { LLM_ARGS } from "../config/llm-args";
import { REPOSITORY_ARGS } from "../config/repository-args";
import { resolveConfig, resolveHookTimeout } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { currentBranch, findRepos, getRepoStatus, git, push } from "../lib/git";
import { getPrContext, github } from "../lib/github";
import { generatePrTitle } from "../lib/llm";
import { buildPrDescription, validateClosesUrl } from "../lib/pr";
import { cleanupWorktrees, prepareWorktreeCleanup } from "../lib/worktrees";
import type { GitOutputReporter, HookReporter, WorktreeCleanupResult } from "../types/git";
import { runTask } from "./git-task";
import { reportError } from "./report-error";

type PublishedPr = WorktreeCleanupResult & { repo: string; branch: string; url: string };

/** Review and publish PRs for the current repository or direct child repositories. */
export const prCommand = defineCommand({
  meta: { name: "pr", description: "Create GitHub PRs for the current repo or direct child repos with AI titles and Conventional Commit descriptions." },
  args: {
    ...REPOSITORY_ARGS,
    ...LLM_ARGS,
    closes: { type: "string", alias: "c", description: "URL of the PM task closed by this PR." },
    branch: { type: "string", alias: "b", description: "Target branch of the PR; defaults to the repository's default branch." },
    yes: { type: "boolean", alias: "y", description: "Push branches and create all PRs without confirmation." },
    "cleanup-worktrees": { type: "boolean", description: "After PR creation, remove the source branch's linked worktree directories without force; run from outside them." },
    json: { type: "boolean", description: "Write PR URLs and worktree cleanup results as JSON; requires --yes in a terminal." },
  },
  async run({ args }) {
    const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const interactive = terminal && !args.json;
    const result: { pullRequests: PublishedPr[]; error?: string } = { pullRequests: [] };
    async function task<T>(title: string, success: string, run: (onOutput: GitOutputReporter, onHook: HookReporter) => Promise<T>): Promise<T> {
      if (!args.json) return runTask(title, success, run);
      return run((chunk) => { process.stderr.write(chunk); }, () => {});
    }
    try {
      if (args.json && terminal && !args.yes) throw new Error("Use --yes with --json in a terminal to confirm PR creation.");
      const closes = validateClosesUrl(args.closes);
      const config = resolveConfig(process.env, args);
      resolveHookTimeout();
      if (interactive) intro("zapdev pr");
      const repos = await findRepos(resolve(args.path));
      if (repos.length === 0) {
        if (!args.json) log.warn("No git repository found here or in direct children.");
        if (interactive) outro("Nothing to do.");
        return;
      }
      const multiple = repos.length > 1;
      async function inRepository<T>(repo: string, run: () => Promise<T>): Promise<T> {
        try {
          return await run();
        } catch (error) {
          if (multiple) throw new Error(`${basename(repo)}: ${errorMessage(error)}`, { cause: error });
          throw error;
        }
      }
      await Promise.all(repos.map((repo) => inRepository(repo, async () => {
        if ((await getRepoStatus(repo)).hasChanges) {
          throw new Error("Cannot create a PR with uncommitted changes (staged, unstaged or untracked files). Commit or stash them, then run zapdev pr again.");
        }
      })));
      const results = await task("Preparing PRs in parallel", "PRs prepared", async () => {
        const results = await Promise.allSettled(repos.map((repo) => inRepository(repo, async () => {
          const context = await getPrContext(repo, args.branch);
          const title = await generatePrTitle(context.commits, config);
          return { repo, context, title, body: buildPrDescription(context.commits, closes) };
        })));
        return results.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
      });
      for (const { repo, context, title, body } of results) {
        if (!args.json) note(`${title}\n\n${body}`, `${multiple ? `${basename(repo)}: ` : ""}${context.branch} → ${context.base}`);
      }
      let selected = results;
      if (interactive && !args.yes) {
        const answer = multiple
          ? await select({
            message: "Action",
            initialValue: "all",
            options: [
              { value: "all", label: "Create all PRs" },
              ...results.map(({ repo }) => ({ value: repo, label: `Create PR only for "${basename(repo)}"` })),
              { value: "cancel", label: "Cancel" },
            ],
          })
          : await confirm({ message: "Push this branch and create the PR?", initialValue: true });
        if (isCancel(answer) || !answer || answer === "cancel") {
          cancel("Cancelled. Nothing pushed or created.");
          return;
        }
        if (typeof answer === "string" && answer !== "all") selected = results.filter(({ repo }) => repo === answer);
      }
      const publications = await Promise.all(selected.map((result) => inRepository(result.repo, async () => {
        const { repo, context } = result;
        if (await currentBranch(repo) !== context.branch || (await git(["rev-parse", "HEAD"], repo)).trim() !== context.head) {
          throw new Error("The branch changed during review. Run zapdev pr again.");
        }
        const cleanup = args["cleanup-worktrees"] ? await prepareWorktreeCleanup(repo, context.branch) : undefined;
        return { ...result, cleanup };
      })));
      for (const { repo, context, title, body } of publications) {
        await inRepository(repo, async () => {
          await task("Pushing branch", "Branch pushed", (onOutput, onHook) =>
            push(repo, context.remote, context.branch, onHook, onOutput));
          const url = await task("Creating PR", "PR created", () => github([
            "pr", "create", "--repo", context.repository, "--base", context.base,
            "--head", context.branch, "--title", title, "--body", body,
          ], repo));
          result.pullRequests.push({ repo, branch: context.branch, url, deletedWorktrees: [], skippedWorktrees: [] });
          if (!args.json) outro(url);
        });
      }
      for (const [index, { repo, context, cleanup }] of publications.entries()) {
        if (!cleanup?.paths.length) continue;
        await inRepository(repo, async () => {
          const cleaned = await task("Cleaning up worktrees", "Worktree cleanup finished", () => cleanupWorktrees(cleanup, context.head));
          Object.assign(result.pullRequests[index]!, cleaned);
          if (!args.json) {
            for (const path of cleaned.deletedWorktrees) log.success(`Deleted worktree: ${JSON.stringify(path)}`);
            for (const { path, reason } of cleaned.skippedWorktrees) log.warn(`Skipped worktree "${path}": ${reason}`);
          }
        });
      }
    } catch (error) {
      if (args.json) {
        result.error = errorMessage(error);
        process.exitCode = 1;
      } else reportError(error);
    } finally {
      if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  },
});
