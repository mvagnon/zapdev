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
import { resolveConfig, resolveHookTimeout } from "../lib/config";
import {
  behindCount,
  commit as gitCommit,
  currentBranch,
  fetchRemote,
  findRepos,
  getRepoStatus,
  getStagedDiff,
  hasUpstream,
  pullMerge,
  pullRebase,
  push,
  pushSetUpstream,
  stageAll,
} from "../lib/git";
import { errorMessage } from "../lib/errors";
import { hasGitleaks, scanStagedChanges } from "../lib/gitleaks";
import { generateCommitMessage } from "../lib/llm";
import { COMMIT_TYPES } from "../types/commit";
import type { ZapdevConfig } from "../types/config";
import type { HookReporter } from "../types/git";

type Repository = { repo: string; label: string; pendingLabel: string };
type CommitDraft = Repository & { message: string };
type CommitAction = "all" | "cancel" | { action: "commit" | "edit"; draft: CommitDraft };
type SyncStrategy = "rebase" | "merge";
type SyncAction = SyncStrategy | "quit";

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
      description: "Push after committing without asking.",
    },
    staged: {
      type: "boolean",
      alias: "s",
      description: "Commit only changes that are already staged.",
    },
    rebase: {
      type: "boolean",
      alias: "r",
      description: "Rebase on the upstream branch if the push is rejected.",
    },
    merge: {
      type: "boolean",
      alias: "m",
      description: "Merge the upstream branch if the push is rejected.",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip prompts and commit directly.",
    },
  },
  async run({ args }) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    if (args.rebase && args.merge) {
      log.error("Choose either --rebase or --merge, not both.");
      process.exitCode = 1;
      return;
    }

    const syncStrategy: SyncStrategy | undefined = args.rebase
      ? "rebase"
      : args.merge
        ? "merge"
        : undefined;

    const type = args.type ? normalizeCommitType(args.type) : undefined;
    if (type === null) {
      log.error(
        `Invalid type "${args.type}". Valid types: ${COMMIT_TYPES.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }

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

    if (drafts.length === 0) {
      if (interactive) outro("No commits prepared.");
      return;
    }

    const selected = await reviewMessages(drafts, interactive && !args.yes);
    if (!selected) {
      cancel("Cancelled (changes left staged).");
      return;
    }

    const committed: CommitDraft[] = [];
    for (const draft of selected) {
      log.info(`${draft.label}: committing`);
      try {
        await gitCommit(draft.repo, draft.message, reportHooks(draft.label));
        committed.push(draft);
        log.success(`${draft.label}: committed ${draft.message}`);
      } catch (error) {
        log.error(`${draft.pendingLabel}: commit failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      }
    }
    if (committed.length === 0) return;

    let shouldPush = Boolean(args.push);
    if (!shouldPush && interactive && !args.yes) {
      const answer = await confirm({
        message: `Push ${committed.map(({ label }) => label).join(", ")}?`,
        initialValue: false,
      });
      if (isCancel(answer)) {
        outro("Committed. Not pushed.");
        return;
      }
      shouldPush = answer;
    }

    if (shouldPush) {
      for (const repository of committed) {
        try {
          const pushed = await pushOptimistic(
            repository,
            interactive && !args.yes,
            syncStrategy,
          );
          if (!pushed) process.exitCode = 1;
        } catch (error) {
          log.error(`${repository.label}: push failed: ${errorMessage(error)}`);
          process.exitCode = 1;
        }
      }
    }

    if (interactive) outro(process.exitCode ? "Finished with errors." : "Done.");
  },
});

function reportHooks(label: string): HookReporter {
  return (event) => {
    const hook = `${label}: ${event.name}`;
    if (event.phase === "start") {
      log.info(`${hook} running`);
    } else {
      if (event.exitCode === 0) log.success(`${hook} ✓`);
      else log.error(`${hook} ✗ (exit ${event.exitCode})`);
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

async function syncWithUpstream(
  { repo, label }: Repository,
  strategy: SyncStrategy,
): Promise<boolean> {
  const actionLabel = strategy === "rebase" ? "Rebase" : "Merge";
  log.info(`${label}: pulling --${strategy === "rebase" ? "rebase" : "no-rebase"}`);
  try {
    await (strategy === "rebase" ? pullRebase : pullMerge)(repo, reportHooks(label));
    log.success(`${label}: ${strategy === "rebase" ? "rebased on upstream" : "merged upstream"}`);
    return true;
  } catch (error) {
    log.error(`${label}: ${actionLabel} failed (resolve conflicts, then push): ${errorMessage(error)}`);
    return false;
  }
}

/** Push optimistically, recovering a behind-upstream rejection once. */
async function pushOptimistic(
  repository: Repository,
  canPrompt: boolean,
  strategy?: SyncStrategy,
): Promise<boolean> {
  const { repo, label } = repository;
  const [upstream, branch] = await Promise.all([hasUpstream(repo), currentBranch(repo)]);
  const doPush = (onHook: HookReporter) => (upstream ? push(repo, onHook) : pushSetUpstream(repo, branch, onHook));

  const first = await tryPush(repository, doPush);
  if (first.ok) return true;

  if (upstream && (await isBehind(repository))) {
    const syncStrategy = strategy ?? (await chooseSyncStrategy(repository, canPrompt));
    if (!syncStrategy || !(await syncWithUpstream(repository, syncStrategy))) return false;

    const retry = await tryPush(repository, doPush);
    if (retry.ok) return true;
    log.error(`${label}: push failed: ${errorMessage(retry.error)}`);
    return false;
  }

  log.error(`${label}: push failed: ${errorMessage(first.error)}`);
  return false;
}

async function chooseSyncStrategy({ label }: Repository, interactive: boolean): Promise<SyncStrategy | null> {
  if (!interactive) {
    log.error(`${label}: branch is behind upstream. Re-run with --rebase or --merge.`);
    return null;
  }

  const action = await select<SyncAction>({
    message: `${label}: branch is behind upstream. How should zapdev sync it?`,
    options: [
      { value: "rebase", label: "Rebase" },
      { value: "merge", label: "Merge" },
      { value: "quit", label: "Quit" },
    ],
  });

  if (isCancel(action) || action === "quit") {
    log.warn("Push cancelled. Commit remains local.");
    return null;
  }

  return action;
}

type PushResult = { ok: true } | { ok: false; error: unknown };

async function tryPush({ label }: Repository, doPush: (onHook: HookReporter) => Promise<void>): Promise<PushResult> {
  log.info(`${label}: pushing`);
  try {
    await doPush(reportHooks(label));
    log.success(`${label}: pushed`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Check the upstream after fetching; preserve the original push error if fetching fails. */
async function isBehind({ repo, label }: Repository): Promise<boolean> {
  log.info(`${label}: checking upstream`);
  try {
    await fetchRemote(repo, reportHooks(label));
    const behind = await behindCount(repo);
    log.info(`${label}: ${
      behind > 0
        ? `Behind upstream by ${behind} commit${behind > 1 ? "s" : ""}`
        : "Up to date with upstream"
    }`);
    return behind > 0;
  } catch (error) {
    log.warn(`${label}: could not check upstream: ${errorMessage(error)}`);
    return false;
  }
}
