import { basename } from "node:path";

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
import { resolveConfig } from "../lib/config";
import {
  behindCount,
  commit as gitCommit,
  currentBranch,
  fetchRemote,
  findRepos,
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

type CommitDraft = { repo: string; message: string };
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
    const results = await Promise.allSettled(repos.map(async (repo) => {
      if (!args.staged) await stageAll(repo);
      const diff = await getStagedDiff(repo);
      if (!diff.trim()) return null;
      if (scan) await scanStagedChanges(repo);
      const message = await generateCommitMessage(diff, config, type);
      if (!message) throw new Error("The model returned an empty message.");
      return { repo, message };
    }));
    loader?.stop("Repositories prepared");

    const drafts: CommitDraft[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        log.error(`${basename(repos[index]!)}: ${errorMessage(result.reason)}`);
        process.exitCode = 1;
      } else if (result.value) {
        drafts.push(result.value);
      } else {
        log.info(`${basename(repos[index]!)}: nothing to commit.`);
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
      try {
        await gitCommit(draft.repo, draft.message);
        committed.push(draft);
        log.success(`${basename(draft.repo)}: committed ${draft.message}`);
      } catch (error) {
        log.error(`${basename(draft.repo)}: commit failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      }
    }
    if (committed.length === 0) return;

    let shouldPush = Boolean(args.push);
    if (!shouldPush && interactive && !args.yes) {
      const answer = await confirm({
        message: `Push ${committed.map(({ repo }) => basename(repo)).join(", ")}?`,
        initialValue: false,
      });
      if (isCancel(answer)) {
        outro("Committed. Not pushed.");
        return;
      }
      shouldPush = answer;
    }

    if (shouldPush) {
      for (const { repo } of committed) {
        try {
          const pushed = await pushOptimistic(
            repo,
            interactive,
            interactive && !args.yes,
            syncStrategy,
          );
          if (!pushed) process.exitCode = 1;
        } catch (error) {
          log.error(`${basename(repo)}: push failed: ${errorMessage(error)}`);
          process.exitCode = 1;
        }
      }
    }

    if (interactive) outro(process.exitCode ? "Finished with errors." : "Done.");
  },
});

async function reviewMessages(drafts: CommitDraft[], canPrompt: boolean): Promise<CommitDraft[] | null> {
  while (true) {
    for (const draft of drafts) log.message(`${basename(draft.repo)}: ${draft.message}`);
    if (!canPrompt) return drafts;

    const action = await select<CommitAction>({
      message: "Action",
      initialValue: "all",
      options: [
        { value: "all", label: drafts.length > 1 ? "Commit all" : "Commit" },
        ...(drafts.length > 1 ? drafts.map((draft) => ({
          value: { action: "commit" as const, draft },
          label: `Commit only "${basename(draft.repo)}"`,
        })) : []),
        ...drafts.map((draft) => ({
          value: { action: "edit" as const, draft },
          label: `Edit message for "${basename(draft.repo)}"`,
        })),
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (isCancel(action) || action === "cancel") return null;
    if (action === "all") return drafts;
    if (action.action === "commit") return [action.draft];

    const edited = await text({
      message: `Edit message for "${basename(action.draft.repo)}"`,
      initialValue: action.draft.message,
      validate: (value) => value?.trim() ? undefined : "Message cannot be empty.",
    });
    if (isCancel(edited)) return null;
    action.draft.message = edited.trim();
  }
}

async function syncWithUpstream(
  repo: string,
  strategy: SyncStrategy,
  interactive: boolean,
): Promise<boolean> {
  const loader = interactive ? spinner() : undefined;
  const label = strategy === "rebase" ? "Rebase" : "Merge";
  loader?.start(`${basename(repo)}: pulling --${strategy === "rebase" ? "rebase" : "no-rebase"}`);
  try {
    await (strategy === "rebase" ? pullRebase(repo) : pullMerge(repo));
    loader?.stop(strategy === "rebase" ? "✓ Rebased on upstream" : "✓ Merged upstream");
    return true;
  } catch (error) {
    loader?.error(`${label} failed`);
    log.error(`${basename(repo)}: ${label} failed (resolve conflicts, then push): ${errorMessage(error)}`);
    return false;
  }
}

/** Push optimistically, recovering a behind-upstream rejection once. */
async function pushOptimistic(
  repo: string,
  interactive: boolean,
  canPrompt: boolean,
  strategy?: SyncStrategy,
): Promise<boolean> {
  const [upstream, branch] = await Promise.all([hasUpstream(repo), currentBranch(repo)]);
  const doPush = () => (upstream ? push(repo) : pushSetUpstream(repo, branch));

  const first = await tryPush(repo, interactive, doPush);
  if (first.ok) return true;

  if (upstream && (await isBehind(repo, interactive))) {
    const syncStrategy = strategy ?? (await chooseSyncStrategy(repo, canPrompt));
    if (!syncStrategy || !(await syncWithUpstream(repo, syncStrategy, interactive))) return false;

    const retry = await tryPush(repo, interactive, doPush);
    if (retry.ok) return true;
    log.error(`${basename(repo)}: push failed: ${errorMessage(retry.error)}`);
    return false;
  }

  log.error(`${basename(repo)}: push failed: ${errorMessage(first.error)}`);
  return false;
}

async function chooseSyncStrategy(repo: string, interactive: boolean): Promise<SyncStrategy | null> {
  if (!interactive) {
    log.error(`${basename(repo)}: branch is behind upstream. Re-run with --rebase or --merge.`);
    return null;
  }

  const action = await select<SyncAction>({
    message: `${basename(repo)}: branch is behind upstream. How should zapdev sync it?`,
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

async function tryPush(repo: string, interactive: boolean, doPush: () => Promise<void>): Promise<PushResult> {
  const loader = interactive ? spinner() : undefined;
  loader?.start(`${basename(repo)}: pushing`);
  try {
    await doPush();
    loader?.stop("✓ Pushed");
    return { ok: true };
  } catch (error) {
    loader?.error("Push failed");
    return { ok: false, error };
  }
}

/** Check the upstream after fetching; preserve the original push error if fetching fails. */
async function isBehind(repo: string, interactive: boolean): Promise<boolean> {
  const loader = interactive ? spinner() : undefined;
  loader?.start(`${basename(repo)}: checking upstream`);
  try {
    await fetchRemote(repo);
    const behind = await behindCount(repo);
    loader?.stop(
      behind > 0
        ? `Behind upstream by ${behind} commit${behind > 1 ? "s" : ""}`
        : "Up to date with upstream",
    );
    return behind > 0;
  } catch (error) {
    loader?.error("Could not check upstream");
    log.warn(`${basename(repo)}: could not check upstream: ${errorMessage(error)}`);
    return false;
  }
}
