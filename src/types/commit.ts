import type { COMMIT_TYPES } from "../config/commit-types";

export type CommitType = (typeof COMMIT_TYPES)[number] | `${(typeof COMMIT_TYPES)[number]}!`;
