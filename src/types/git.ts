/** Line counts in a staged diff, excluding binary files. */
export type DiffStats = { additions: number; deletions: number };

/** A Git hook invocation observed through Trace2. */
export type HookEvent =
  | { name: string; phase: "start" }
  | { name: string; phase: "exit"; exitCode: number };

/** Receive hook progress without changing how Git executes the hook. */
export type HookReporter = (event: HookEvent) => void;

/** Receive decoded live output from Git's stdout or stderr. */
export type GitOutputReporter = (chunk: string, stream: "stdout" | "stderr") => void;

/** Linked worktrees selected for cleanup, executed from the preserved main repository. */
export type WorktreeCleanup = { repo: string; branch: string; paths: string[] };

/** Worktree directories actually deleted or preserved with their cleanup failure reason. */
export type WorktreeCleanupResult = {
  deletedWorktrees: string[];
  skippedWorktrees: { path: string; reason: string }[];
};
