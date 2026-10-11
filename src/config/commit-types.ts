/** Supported Conventional Commit types, shared by prompts and validation. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "deps",
  "chore",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "revert",
] as const;
