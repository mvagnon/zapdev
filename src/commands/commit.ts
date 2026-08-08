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
import { generateCommitMessage } from "../lib/ollama";
import { COMMIT_TYPES } from "../types/commit";

type CommitAction = "commit" | "edit" | "cancel";
type SyncStrategy = "rebase" | "merge";
type SyncAction = SyncStrategy | "quit";

export const commitCommand = defineCommand({
  meta: {
    name: "commit",
    description:
      "Stage all changes and commit with an LLM-generated Conventional Commits message.",
  },
  args: {
    model: {
      type: "string",
      description: "Override the Ollama model (defaults to $OLLAMA_MODEL).",
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
    const config = resolveConfig(
      process.env,
      args.model ? { model: args.model } : {},
    );

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

    if (interactive) intro("zapdev commit");

    if (!args.staged) await stageAll();
    const diff = await getStagedDiff();
    if (!diff.trim()) {
      log.warn("Nothing to commit.");
      if (interactive) outro("Nothing to do.");
      return;
    }

    try {
      if (await hasGitleaks()) {
        const scanLoader = interactive ? spinner() : undefined;
        scanLoader?.start("Scanning staged changes with Gitleaks");
        try {
          await scanStagedChanges();
          scanLoader?.stop("No leaks found");
        } catch (error) {
          scanLoader?.error("Gitleaks check failed");
          throw error;
        }
      } else {
        log.info("Gitleaks not found, skipping secret scan.");
      }
    } catch (error) {
      log.error(`Gitleaks check failed: ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    const loader = interactive ? spinner() : undefined;
    loader?.start("Generating commit message");

    let message: string;
    try {
      message = await generateCommitMessage(diff, config, type);
    } catch (error) {
      loader?.error("Generation failed");
      log.error(`Generation failed: ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    if (!message) {
      loader?.error("Generation failed");
      log.error("Generation failed: the model returned an empty message.");
      process.exitCode = 1;
      return;
    }

    if (loader) loader.stop(message);
    else log.message(message);

    let finalMessage = message;

    if (interactive && !args.yes) {
      const action = await select<CommitAction>({
        message: "Action",
        initialValue: "commit",
        options: [
          { value: "commit", label: "Commit" },
          { value: "edit", label: "Edit message" },
          { value: "cancel", label: "Cancel" },
        ],
      });

      if (isCancel(action) || action === "cancel") {
        cancel("Cancelled (changes left staged).");
        return;
      }

      if (action === "edit") {
        const edited = await text({
          message: "Edit message",
          initialValue: message,
        });
        if (isCancel(edited)) {
          cancel("Cancelled (changes left staged).");
          return;
        }
        finalMessage = edited.trim();
        if (!finalMessage) {
          cancel("Empty message, cancelled.");
          return;
        }
      }
    }

    await gitCommit(finalMessage);
    if (interactive) log.success(`Committed: ${finalMessage}`);

    let shouldPush = Boolean(args.push);
    if (!shouldPush && interactive && !args.yes) {
      const answer = await confirm({ message: "Push?", initialValue: false });
      if (isCancel(answer)) {
        if (interactive) outro("Committed. Not pushed.");
        return;
      }
      shouldPush = answer;
    }

    if (shouldPush) {
      const pushed = await pushOptimistic(
        interactive,
        interactive && !args.yes,
        syncStrategy,
      );
      if (!pushed) {
        process.exitCode = 1;
        return;
      }
    }

    if (interactive) outro("Done.");
  },
});

async function syncWithUpstream(
  strategy: SyncStrategy,
  interactive: boolean,
): Promise<boolean> {
  const loader = interactive ? spinner() : undefined;
  const label = strategy === "rebase" ? "Rebase" : "Merge";
  loader?.start(`Pulling --${strategy === "rebase" ? "rebase" : "no-rebase"}`);
  try {
    await (strategy === "rebase" ? pullRebase() : pullMerge());
    loader?.stop(strategy === "rebase" ? "✓ Rebased on upstream" : "✓ Merged upstream");
    return true;
  } catch (error) {
    loader?.error(`${label} failed`);
    log.error(`${label} failed (resolve conflicts, then push): ${errorMessage(error)}`);
    return false;
  }
}

// Pushes without a preliminary fetch, so the common case stays a single round-trip.
// On failure, diagnoses "behind upstream" by fetching and comparing (only on this
// rare path) rather than parsing stderr. A behind rejection is recovered
// with the selected strategy, then retry the push once.
async function pushOptimistic(
  interactive: boolean,
  canPrompt: boolean,
  strategy?: SyncStrategy,
): Promise<boolean> {
  const [upstream, branch] = await Promise.all([hasUpstream(), currentBranch()]);
  const doPush = () => (upstream ? push() : pushSetUpstream(branch));

  const first = await tryPush(interactive, doPush);
  if (first.ok) return true;

  if (upstream && (await isBehind(interactive))) {
    const syncStrategy = strategy ?? (await chooseSyncStrategy(canPrompt));
    if (!syncStrategy || !(await syncWithUpstream(syncStrategy, interactive))) return false;

    const retry = await tryPush(interactive, doPush);
    if (retry.ok) return true;
    log.error(`Push failed: ${errorMessage(retry.error)}`);
    return false;
  }

  log.error(`Push failed: ${errorMessage(first.error)}`);
  return false;
}

async function chooseSyncStrategy(interactive: boolean): Promise<SyncStrategy | null> {
  if (!interactive) {
    log.error("Branch is behind upstream. Re-run with --rebase or --merge.");
    return null;
  }

  const action = await select<SyncAction>({
    message: "Branch is behind upstream. How should zapdev sync it?",
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

async function tryPush(interactive: boolean, doPush: () => Promise<void>): Promise<PushResult> {
  const loader = interactive ? spinner() : undefined;
  loader?.start("Pushing");
  try {
    await doPush();
    loader?.stop("✓ Pushed");
    return { ok: true };
  } catch (error) {
    loader?.error("Push failed");
    return { ok: false, error };
  }
}

// Fetches, then checks whether the branch trails its upstream. A failed fetch
// (offline, auth) is treated as "not behind" so the original push error surfaces.
async function isBehind(interactive: boolean): Promise<boolean> {
  const loader = interactive ? spinner() : undefined;
  loader?.start("Checking upstream");
  try {
    await fetchRemote();
    const behind = await behindCount();
    loader?.stop(
      behind > 0
        ? `Behind upstream by ${behind} commit${behind > 1 ? "s" : ""}`
        : "Up to date with upstream",
    );
    return behind > 0;
  } catch (error) {
    loader?.error("Could not check upstream");
    log.warn(`Could not check upstream: ${errorMessage(error)}`);
    return false;
  }
}
