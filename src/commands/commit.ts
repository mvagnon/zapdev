import { basename, resolve } from "node:path";
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
  text,
} from "@clack/prompts";

import { COMMIT_TYPES } from "../config/commit-types";
import { INTERACTION_ARGS } from "../config/interaction-args";
import { LLM_ARGS } from "../config/llm-args";
import { PROTECTED_BRANCHES } from "../config/protected-branches";
import { REPOSITORY_ARGS } from "../config/repository-args";
import { resolveConfig, resolveHookTimeout } from "../lib/config";
import { validateCommitMessage } from "../lib/commit-message";
import {
  commit as gitCommit,
  currentBranch,
  findRepos,
  getPushRemote,
  getUpstreamRemote,
  getRepoStatus,
  getStagedDiff,
  getStagedDiffStats,
  git as runGit,
  push,
  stageAll,
  switchBranch,
} from "../lib/git";
import { errorMessage } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import type { CommitType } from "../types/commit";
import type { DiffStats, GitOutputReporter, HookReporter } from "../types/git";
import { runTask } from "./git-task";
import { reportError } from "./report-error";

type Repository = { repo: string; label: string; pendingLabel: string };
type CommitDraft = Repository & { message: string; stats: DiffStats };
type CommitAction = "all" | "cancel" | { action: "commit" | "edit"; draft: CommitDraft };
type CompletedCommit = { repo: string; branch: string; message: string; pushed: boolean };

/** Commit the current repository or review direct child repositories together. */
export const commitCommand = defineCommand({
  meta: {
    name: "commit",
    description:
      "Generate and review commit messages for the current repo or direct child repos.",
  },
  args: {
    ...INTERACTION_ARGS,
    ...REPOSITORY_ARGS,
    ...LLM_ARGS,
    type: {
      type: "enum",
      options: COMMIT_TYPES.flatMap((type) => [type, `${type}!` as const]),
      required: false,
      alias: "t",
      description: `Force the Conventional Commits type (${COMMIT_TYPES.join(", ")}); append ! for a breaking change.`,
    },
    "ask-for-type": {
      type: "boolean",
      alias: "T",
      description: "Choose a commit type and confirm a breaking change before generating messages.",
    },
    push: {
      type: "boolean",
      alias: "p",
      description: "Skip push confirmation and push the current branch.",
      negativeDescription: "Keep commits local without push confirmation.",
    },
    pull: {
      type: "boolean",
      description: "Pull fast-forward updates before staging or generating commit messages.",
    },
    branch: {
      type: "string",
      description: "Commit to this local branch in every repository without asking; create it if needed.",
    },
    "ask-for-branch": {
      type: "boolean",
      alias: "A",
      description: "Ask for a local branch before every commit, even on nonprotected branches.",
    },
    staged: {
      type: "boolean",
      alias: "s",
      description: "Commit only changes that are already staged.",
    },
    json: {
      type: "boolean",
      description: "Write commit results and warnings as JSON; requires --non-interactive in a terminal.",
    },
  },
  async run({ args }) {
    const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const interactive = terminal && !args["non-interactive"] && !args.json;
    const skipPrompts = args["non-interactive"] || args.yes;
    const result: { commits: CompletedCommit[]; warnings: string[]; error?: string } = { commits: [], warnings: [] };
    function warn(message: string): void {
      result.warnings.push(message);
      if (!args.json) log.warn(message, { spacing: 0 });
    }
    async function task<T>(title: string, success: string, run: (onOutput: GitOutputReporter, onHook: HookReporter) => Promise<T>, withGuide = true): Promise<T> {
      if (!args.json) return runTask(title, success, run, withGuide);
      return run((chunk) => { process.stderr.write(chunk); }, () => {});
    }

    try {
      if (args.json && terminal && !skipPrompts) throw new Error("Use --non-interactive with --json in a terminal to confirm commits.");
      resolveHookTimeout();
      const config = resolveConfig(process.env, {
        url: args.url,
        model: args.model,
        effort: args.effort,
      });
      if (interactive) intro("zapdev commit");

      const repos = await findRepos(resolve(args.path));
      if (args["non-interactive"] && args.branch !== undefined && repos.length) await runGit(["check-ref-format", "--branch", args.branch], repos[0]!);
      if (repos.length === 0) {
        if (args["non-interactive"]) throw new Error(`No Git repository found in ${resolve(args.path)} or its immediate children.`);
        if (!args.json) log.warn("No git repository found here or in direct children.");
        if (interactive) outro("Nothing to do.");
        return;
      }

      if (args.pull) {
        const pulls = await task("Pulling repositories in parallel", "Repositories pulled", async (onOutput, onHook) => {
          const results = await Promise.allSettled(repos.map(async (repo) => {
            const label = basename(repo);
            const hasChanges = args.staged
              ? Boolean((await getStagedDiff(repo)).trim())
              : (await getRepoStatus(repo)).hasChanges;
            if (!hasChanges) return null;
            const branch = await currentBranch(repo);
            if (!await getUpstreamRemote(repo, branch)) {
              return `${label}: no configured upstream remote. Skipping pull.`;
            }
            await runGit(["pull", "--ff-only", "--no-rebase", "--no-autostash"], repo, onHook, onOutput);
            return null;
          }));
          for (const [index, result] of results.entries()) {
            if (result.status === "rejected") throw new Error(`${basename(repos[index]!)}: ${errorMessage(result.reason)}`);
          }
          return results;
        });
        for (const result of pulls) {
          if (result.status === "fulfilled" && result.value) warn(result.value);
        }
      }

      let type = args.type;
      if (args["ask-for-type"] && !args["non-interactive"]) {
        if (!interactive) throw new Error("Choosing a commit type requires a terminal.");
        const selectedType = await select<"auto" | (typeof COMMIT_TYPES)[number]>({
          message: "Commit type",
          initialValue: "auto",
          options: [{ value: "auto", label: "auto" }, ...COMMIT_TYPES.map((value) => ({ value, label: value }))],
        });
        if (isCancel(selectedType)) {
          cancel("Cancelled.");
          return;
        }
        if (selectedType === "auto") {
          type = undefined;
        } else {
          const breaking = await confirm({ message: "Breaking change?", initialValue: false });
          if (isCancel(breaking)) {
            cancel("Cancelled.");
            return;
          }
          type = breaking ? `${selectedType}!` : selectedType;
        }
      }

      const repositories: Repository[] = repos.map((repo) => ({ repo, label: basename(repo), pendingLabel: basename(repo) }));
      const { results, scan } = await task("Preparing repositories and generating commit messages in parallel", "Repositories prepared", async (onOutput, onHook) => {
        const scan = await hasGitleaks();
        const results = await Promise.allSettled(repositories.map(async (repository) => {
          const { repo } = repository;
          const { branch, hasChanges } = await getRepoStatus(repo);
          repository.label = `${basename(repo)} (${branch})`;
          repository.pendingLabel = hasChanges && !args.json ? styleText("bold", repository.label) : repository.label;
          if (!args.staged) await stageAll(repo, onOutput, onHook);
          const diff = await getStagedDiff(repo);
          if (!diff.trim()) return null;
          const stats = await getStagedDiffStats(repo);
          if (scan) await scanStagedChanges(repo, onOutput);
          const message = await generateCommitMessage(diff, config, type);
          return { ...repository, message, stats };
        }));
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") throw new Error(`${repositories[index]!.pendingLabel}: ${errorMessage(result.reason)}`);
        }
        return { results, scan };
      });
      if (!scan) {
        const warning = "Gitleaks not found, skipping secret scan.";
        result.warnings.push(warning);
        if (!args.json) log.info(warning, { spacing: 0 });
      }

      const drafts: CommitDraft[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          if (result.value) {
            drafts.push(result.value);
          } else if (!args.json) log.info(`${repositories[index]!.pendingLabel}: nothing to commit.`, { spacing: 0 });
        }
      }

      const selected = args.json ? drafts : drafts.length ? await reviewMessages(drafts, interactive && !skipPrompts, type) : [];
      if (!selected) {
        cancel("Cancelled (changes left staged).");
        return;
      }

      const toSend: Repository[] = [];
      let previousBranchInput = "";
      for (const draft of selected) {
        let withGuide = true;
        let targetBranch = args.branch;
        const current = await currentBranch(draft.repo);
        if (targetBranch === undefined && !args["non-interactive"] && (args["ask-for-branch"] || (!skipPrompts && PROTECTED_BRANCHES.includes(current)))) {
          if (!interactive) throw new Error("Choosing a branch before committing requires a terminal. Changes remain staged.");
          const answer = await text({
            message: `${basename(draft.repo)} (${current}): branch to commit to`,
            initialValue: previousBranchInput,
          });
          if (isCancel(answer)) {
            cancel("Committing cancelled. Changes remain staged; earlier commits stay local.");
            return;
          }
          previousBranchInput = answer.trim();
          withGuide = Boolean(previousBranchInput);
          targetBranch = previousBranchInput || current;
        }
        if (targetBranch === current) targetBranch = undefined;
        if (targetBranch !== undefined) {
          draft.label = `${basename(draft.repo)} (${targetBranch})`;
          draft.pendingLabel = styleText("bold", draft.label);
        }
        await task(`${draft.label}: commit`, `${draft.label}: committed ${draft.message}`, async (onOutput, onHook) => {
          if (targetBranch !== undefined) await switchBranch(draft.repo, targetBranch, onHook, onOutput);
          await gitCommit(draft.repo, draft.message, onHook, onOutput);
        }, withGuide);
        result.commits.push({ repo: draft.repo, branch: targetBranch ?? current, message: draft.message, pushed: false });
        toSend.push(draft);
      }
      if (toSend.length === 0) return;
      if (args.push === false || ((skipPrompts || !interactive) && !args.push)) return;

      const destinations: { repo: string; label: string; branch: string; remote: string }[] = [];
      for (const { repo, label } of toSend) {
        const branch = await currentBranch(repo);
        const remote = await getPushRemote(repo, branch);
        if (remote) destinations.push({ repo, label, branch, remote });
        else warn(`${label}: no unambiguous push remote. Skipping push; commit remains local.`);
      }

      let shouldPush = Boolean(args.push);
      if (!shouldPush && interactive && destinations.length) {
        const answer = await confirm({
          message: `Push ${destinations.map(({ label }) => label).join(", ")}?`,
          initialValue: false,
        });
        if (isCancel(answer)) {
          cancel("Committed. Not pushed.");
          return;
        }
        shouldPush = answer;
      }

      if (shouldPush && destinations.length) {
        await task("Pushing repositories in parallel", "Repositories pushed", async (onOutput, onHook) => {
          const results = await Promise.allSettled(destinations.map(async ({ repo, branch, remote }) => {
            await push(repo, remote, branch, onHook, onOutput);
            const committed = result.commits.find(commit => commit.repo === repo);
            if (committed) committed.pushed = true;
          }));
          for (const [index, result] of results.entries()) {
            if (result.status === "rejected") throw new Error(`${destinations[index]!.label}: ${errorMessage(result.reason)}`);
          }
        });
      }

      if (interactive) outro("Done.");
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

async function reviewMessages(drafts: CommitDraft[], canPrompt: boolean, type?: CommitType): Promise<CommitDraft[] | null> {
  while (true) {
    for (const [index, { stats, pendingLabel, message }] of drafts.entries()) {
      log.message(`(${styleText("green", `+${stats.additions}`)} ${styleText("red", `-${stats.deletions}`)}) ${pendingLabel}: ${message}`, { spacing: index === 0 ? 1 : 0 });
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
      validate: (value) => validateCommitMessage(value?.trim() ?? "", type),
    });
    if (isCancel(edited)) return null;
    action.draft.message = edited.trim();
  }
}
