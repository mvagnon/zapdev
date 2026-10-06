import { basename } from "node:path";
import { styleText } from "node:util";

import { defineCommand } from "citty";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  taskLog,
  text,
} from "@clack/prompts";

import { resolveConfig, resolveHookTimeout } from "../lib/config";
import {
  commit as gitCommit,
  currentBranch,
  findRepos,
  getUpstreamRemote,
  getRepoStatus,
  getStagedDiff,
  getStagedDiffStats,
  git as runGit,
  push,
  stageAll,
  switchBranch,
} from "../lib/git";
import { errorMessage, GitOutputError } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { COMMIT_TYPES } from "../types/commit";
import type { ZapdevConfig } from "../types/config";
import type { DiffStats } from "../types/git";
import { runGitTask } from "./git-task";

type Repository = { repo: string; label: string; pendingLabel: string };
type CommitDraft = Repository & { message: string; stats: DiffStats };
type CommitAction = "all" | "cancel" | { action: "commit" | "edit"; draft: CommitDraft };

/** Commit the current repository or review direct child repositories together. */
export const commitCommand = defineCommand({
  meta: {
    name: "commit",
    description:
      "Generate and review commit messages for the current repo or direct child repos.",
  },
  args: {
    url: {
      type: "string",
      description: "Override $ZD_URL, the complete Chat Completions endpoint.",
    },
    model: {
      type: "string",
      description: "Override the model configured with $ZD_MODEL.",
    },
    effort: {
      type: "string",
      description: "Override $ZD_EFFORT, sent as reasoning_effort.",
    },
    type: {
      type: "enum",
      options: [...COMMIT_TYPES],
      required: false,
      alias: "t",
      description: `Force the Conventional Commits type (${COMMIT_TYPES.join(", ")}).`,
    },
    push: {
      type: "boolean",
      alias: "p",
      description: "Skip push confirmation and push the current branch.",
    },
    pull: {
      type: "boolean",
      description: "Pull fast-forward updates before staging or generating commit messages.",
    },
    staged: {
      type: "boolean",
      alias: "s",
      description: "Commit only changes that are already staged.",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip commit review; still confirm push unless --push is set.",
    },
  },
  async run({ args }) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    let config: ZapdevConfig;
    try {
      resolveHookTimeout();
      config = resolveConfig(process.env, {
        url: args.url,
        model: args.model,
        effort: args.effort,
      });
    } catch (error) {
      log.error(errorMessage(error));
      process.exitCode = 1;
      return;
    }

    if (interactive) intro("zapdev commit");

    const repos = await findRepos(process.cwd());
    if (repos.length === 0) {
      log.warn("No git repository found here or in direct children.");
      if (interactive) outro("Nothing to do.");
      return;
    }

    const loader = interactive ? spinner() : undefined;
    if (args.pull) {
      loader?.start("Pulling repositories in parallel");
      let pullLog: ReturnType<typeof taskLog> | undefined;
      const pulls = await Promise.allSettled(repos.map(async (repo) => {
        const label = basename(repo);
        const hasChanges = args.staged
          ? Boolean((await getStagedDiff(repo)).trim())
          : (await getRepoStatus(repo)).hasChanges;
        if (!hasChanges) return true;
        const branch = await currentBranch(repo);
        if (!await getUpstreamRemote(repo, branch)) {
          return `${label}: no configured upstream remote. Skipping pull.`;
        }
        if (interactive) {
          loader?.clear();
          pullLog ??= taskLog({ title: "Pulling repositories in parallel", limit: 10, retainLog: true });
        }
        return runGitTask(label, "pull", `${label}: pulled`, (onHook, onOutput) =>
          runGit(["pull", "--ff-only", "--no-rebase", "--no-autostash"], repo, onHook, onOutput), pullLog?.group(label));
      }));
      loader?.clear();
      const failed = pulls.some((result) => result.status === "rejected" || result.value === false);
      if (failed) pullLog?.error("Pulling failed");
      else pullLog?.success("Repositories pulled", { showLog: true });
      for (const [index, result] of pulls.entries()) {
        if (result.status === "rejected") reportGitFailure(`${basename(repos[index]!)}: pull failed`, result.reason);
        else if (typeof result.value === "string") log.warn(result.value);
      }
      if (failed) {
        process.exitCode = 1;
        return;
      }
    }

    let scan: boolean;
    try {
      scan = await hasGitleaks();
    } catch (error) {
      log.error(`Gitleaks check failed: ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }
    if (!scan) log.info("Gitleaks not found, skipping secret scan.");

    loader?.start("Preparing repositories and generating commit messages in parallel");
    const repositories: Repository[] = repos.map((repo) => ({ repo, label: basename(repo), pendingLabel: basename(repo) }));
    const results = await Promise.allSettled(repositories.map(async (repository) => {
      const { repo } = repository;
      const { branch, hasChanges } = await getRepoStatus(repo);
      repository.label = `${basename(repo)} (${branch})`;
      repository.pendingLabel = hasChanges ? styleText("bold", repository.label) : repository.label;
      if (!args.staged) await stageAll(repo);
      const diff = await getStagedDiff(repo);
      if (!diff.trim()) return null;
      const stats = await getStagedDiffStats(repo);
      if (scan) await scanStagedChanges(repo);
      const message = await generateCommitMessage(diff, config, args.type);
      if (!message) throw new Error("The model returned an empty message.");
      return { ...repository, message, stats };
    }));
    loader?.stop("Repositories prepared");

    const drafts: CommitDraft[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        log.error(`${repositories[index]!.pendingLabel}: ${errorMessage(result.reason)}`);
        process.exitCode = 1;
      } else if (result.value) {
        drafts.push(result.value);
      } else {
        log.info(`${repositories[index]!.pendingLabel}: nothing to commit.`);
      }
    }

    const selected = drafts.length ? await reviewMessages(drafts, interactive && !args.yes) : [];
    if (!selected) {
      cancel("Cancelled (changes left staged).");
      return;
    }

    const toSend: Repository[] = [];
    let previousBranchInput = "";
    for (const draft of selected) {
      try {
        const current = await currentBranch(draft.repo);
        if (/^(main|master|principal|dev|development)$/.test(current)) {
          if (!interactive) throw new Error("Committing on a protected branch requires a terminal to choose a branch. Changes remain staged.");
          const answer = await text({
            message: `${basename(draft.repo)} (${current}): branch to commit to`,
            initialValue: previousBranchInput,
          });
          if (isCancel(answer)) {
            cancel("Committing cancelled. Changes remain staged; earlier commits stay local.");
            return;
          }
          previousBranchInput = answer.trim();
          const branch = previousBranchInput || current;
          if (branch !== current) {
            await switchBranch(draft.repo, branch);
            draft.label = `${basename(draft.repo)} (${branch})`;
            draft.pendingLabel = styleText("bold", draft.label);
          }
        }
        if (!await runGitTask(draft.label, "commit", `${draft.label}: committed ${draft.message}`, (onHook, onOutput) =>
          gitCommit(draft.repo, draft.message, onHook, onOutput))) {
          process.exitCode = 1;
          continue;
        }
        toSend.push(draft);
      } catch (error) {
        reportGitFailure(`${draft.pendingLabel}: commit failed`, error);
        process.exitCode = 1;
      }
    }
    if (toSend.length === 0) return;
    if (!interactive && !args.push) return;

    const destinations: { repo: string; label: string; branch: string; remote: string }[] = [];
    for (const { repo, label } of toSend) {
      try {
        const branch = await currentBranch(repo);
        const remote = await getUpstreamRemote(repo, branch);
        if (remote) destinations.push({ repo, label, branch, remote });
        else log.warn(`${label}: no configured upstream remote. Skipping push; commit remains local.`);
      } catch (error) {
        reportGitFailure(`${label}: push failed`, error);
        process.exitCode = 1;
        return;
      }
    }

    let shouldPush = Boolean(args.push);
    if (!shouldPush && interactive && destinations.length) {
      const answer = await confirm({
        message: `Push ${destinations.map(({ label }) => label).join(", ")}?`,
        initialValue: false,
      });
      if (isCancel(answer)) {
        outro("Committed. Not pushed.");
        return;
      }
      shouldPush = answer;
    }

    if (shouldPush) {
      for (const { repo, label, branch, remote } of destinations) {
        if (!await runGitTask(label, "push", `${label}: pushed to ${remote}/${branch}`, (onHook, onOutput) =>
          push(repo, remote, branch, onHook, onOutput))) {
          process.exitCode = 1;
          outro("Sending stopped after a Git failure.");
          return;
        }
      }
    }

    if (interactive) outro(process.exitCode ? "Finished with errors." : "Done.");
  },
});

/** Report Git failures without repeating native diagnostics or hook failure statuses. */
function reportGitFailure(message: string, error: unknown): void {
  if (error instanceof GitOutputError && error.hookFailureReported) return;
  log.error(error instanceof GitOutputError ? message : `${message}: ${errorMessage(error)}`);
}

async function reviewMessages(drafts: CommitDraft[], canPrompt: boolean): Promise<CommitDraft[] | null> {
  while (true) {
    for (const { stats, pendingLabel, message } of drafts) {
      log.message(`(${styleText("green", `+${stats.additions}`)} ${styleText("red", `-${stats.deletions}`)}) ${pendingLabel}: ${message}`);
    }
    if (!canPrompt) return drafts;

    const action = await select<CommitAction>({
      message: "Action",
      initialValue: "all",
      options: [
        { value: "all", label: drafts.length > 1 ? "Commit all" : "Commit" },
        ...(drafts.length > 1 ? drafts.map((draft) => ({
          value: { action: "commit" as const, draft },
          label: `Commit only "${draft.pendingLabel}"`,
        })) : []),
        ...drafts.map((draft) => ({
          value: { action: "edit" as const, draft },
          label: `Edit message for "${draft.pendingLabel}"`,
        })),
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (isCancel(action) || action === "cancel") return null;
    if (action === "all") return drafts;
    if (action.action === "commit") return [action.draft];

    const edited = await text({
      message: `Edit message for "${action.draft.pendingLabel}"`,
      initialValue: action.draft.message,
      validate: (value) => value?.trim() ? undefined : "Message cannot be empty.",
    });
    if (isCancel(edited)) return null;
    action.draft.message = edited.trim();
  }
}
