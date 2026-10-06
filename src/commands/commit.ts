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
  text,
} from "@clack/prompts";

import { normalizeCommitType } from "../lib/commit-message";
import { resolveConfig, resolveHookTimeout, resolveSubtrees } from "../lib/config";
import {
  commit as gitCommit,
  currentBranch,
  findRepos,
  getPushRemote,
  getRepoStatus,
  getStagedDiff,
  hasUnpushedCommits,
  publishSubtree,
  push,
  stageAll,
} from "../lib/git";
import { errorMessage, GitOutputError } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { COMMIT_TYPES } from "../types/commit";
import type { SubtreeMapping, ZapdevConfig } from "../types/config";
import type { HookReporter } from "../types/git";
import { reportNativeOutput } from "./native-output";

type Repository = { repo: string; label: string; pendingLabel: string };
type CommitDraft = Repository & { message: string };
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
      type: "string",
      alias: "t",
      description: `Force the Conventional Commits type (${COMMIT_TYPES.join(", ")}).`,
    },
    push: {
      type: "boolean",
      alias: "p",
      description: "Skip push confirmation; still ask for each destination branch.",
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

    const type = args.type ? normalizeCommitType(args.type) : undefined;
    if (type === null) {
      log.error(
        `Invalid type "${args.type}". Valid types: ${COMMIT_TYPES.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }

    let config: ZapdevConfig;
    let subtrees: SubtreeMapping;
    try {
      resolveHookTimeout();
      config = resolveConfig(process.env, {
        url: args.url,
        model: args.model,
        effort: args.effort,
      });
      subtrees = await resolveSubtrees(process.cwd());
    } catch (error) {
      log.error(errorMessage(error));
      process.exitCode = 1;
      return;
    }

    const publishSubtreeMode = Object.keys(subtrees).length > 0;
    if (interactive) intro("zapdev commit");

    const repos = await findRepos(process.cwd());
    if (repos.length === 0) {
      log.warn("No git repository found here or in direct children.");
      if (interactive) outro("Nothing to do.");
      return;
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

    const loader = interactive ? spinner() : undefined;
    loader?.start("Preparing repositories and generating commit messages in parallel");
    const repositories: Repository[] = repos.map((repo) => ({ repo, label: basename(repo), pendingLabel: basename(repo) }));
    const results = await Promise.allSettled(repositories.map(async (repository) => {
      const { repo } = repository;
      const { branch, hasChanges } = await getRepoStatus(repo);
      repository.label = `${basename(repo)} (${branch})`;
      repository.pendingLabel = hasChanges ? styleText(["bold", "underline"], repository.label) : repository.label;
      if (!args.staged) await stageAll(repo);
      const diff = await getStagedDiff(repo);
      if (!diff.trim()) return null;
      if (scan) await scanStagedChanges(repo);
      const message = await generateCommitMessage(diff, config, type);
      if (!message) throw new Error("The model returned an empty message.");
      return { ...repository, message };
    }));
    loader?.stop("Repositories prepared");

    const drafts: CommitDraft[] = [];
    const unchanged: Repository[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        log.error(`${repositories[index]!.pendingLabel}: ${errorMessage(result.reason)}`);
        process.exitCode = 1;
      } else if (result.value) {
        drafts.push(result.value);
      } else {
        log.info(`${repositories[index]!.pendingLabel}: nothing to commit.`);
        unchanged.push(repositories[index]!);
      }
    }

    const selected = drafts.length ? await reviewMessages(drafts, interactive && !args.yes) : [];
    if (!selected) {
      cancel("Cancelled (changes left staged).");
      return;
    }

    const committed: CommitDraft[] = [];
    for (const draft of selected) {
      log.info(`${draft.label}: committing`);
      try {
        await gitCommit(draft.repo, draft.message, reportHooks(draft.label), reportNativeOutput);
        committed.push(draft);
        log.success(`${draft.label}: committed ${draft.message}`);
      } catch (error) {
        reportGitFailure(`${draft.pendingLabel}: commit failed`, error);
        process.exitCode = 1;
      }
    }
    const toSend: Repository[] = [...committed, ...unchanged];
    if (toSend.length === 0) return;

    let shouldPush = Boolean(args.push);
    if (!shouldPush && interactive) {
      const answer = await confirm({
        message: `${publishSubtreeMode ? "Publish subtrees in" : "Push"} ${toSend.map(({ label }) => label).join(", ")}?`,
        initialValue: false,
      });
      if (isCancel(answer)) {
        outro(publishSubtreeMode ? "Committed. Not published." : "Committed. Not pushed.");
        return;
      }
      shouldPush = answer;
    }

    if (shouldPush) {
      if (!interactive) {
        log.error("Pushing requires a terminal to choose each destination branch. Commits remain local.");
        process.exitCode = 1;
        return;
      }
      let previousBranchInput = "";
      for (const repository of toSend) {
        const { repo, label } = repository;
        try {
          const current = await currentBranch(repo);
          const destinations: [string, string | null][] = publishSubtreeMode
            ? Object.entries(subtrees)
            : [["", await getPushRemote(repo, current)]];
          for (const [prefix, remote] of destinations) {
            if (!remote) {
              log.warn(`${label}: no remote or ambiguous remote choice. Skipping push; commit remains local.`);
              continue;
            }
            log.info(`${label}: checking unpublished commits${prefix ? ` in ${prefix}` : ""} (${remote}/${previousBranchInput || current}).`);
            if (!await hasUnpushedCommits(repo, remote, previousBranchInput || current, reportHooks(label), prefix || undefined, reportNativeOutput)) {
              log.info(`${label}: no unpushed commits${prefix ? ` in ${prefix}` : ""}. Skipping.`);
              continue;
            }
            const answer = await text({
              message: `${label}: branch to push ${publishSubtreeMode ? `${prefix} to ` : "to "}${remote}`,
              initialValue: previousBranchInput,
            });
            if (isCancel(answer)) {
              outro("Sending cancelled. Remaining commits stay local.");
              return;
            }
            previousBranchInput = answer.trim();
            const branch = previousBranchInput || current;
            log.info(`${label}: pushing ${publishSubtreeMode ? `${prefix} → ` : ""}${remote}/${branch}`);
            if (publishSubtreeMode) await publishSubtree(repo, prefix, remote, branch, reportHooks(label), reportNativeOutput);
            else await push(repo, remote, branch, reportHooks(label), reportNativeOutput);
            log.success(`${label}: pushed to ${remote}/${branch}`);
          }
        } catch (error) {
          reportGitFailure(`${label}: ${publishSubtreeMode ? "publication" : "push"} failed`, error);
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

function reportHooks(label: string): HookReporter {
  const options = { secondarySymbol: "", withGuide: false };
  return (event) => {
    const hook = `${label}: ${event.name}`;
    if (event.phase === "start") {
      log.step(styleText("bold", hook), options);
    } else {
      if (event.exitCode === 0) log.success(`${hook}: completed`, options);
      else log.error(`${hook}: failed (exit ${event.exitCode})`, options);
    }
  };
}

async function reviewMessages(drafts: CommitDraft[], canPrompt: boolean): Promise<CommitDraft[] | null> {
  while (true) {
    for (const draft of drafts) log.message(`${draft.pendingLabel}: ${draft.message}`);
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
