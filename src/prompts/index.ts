import commitMessagePrompt from "./commit-message.md";
import diffIgnorePatterns from "../config/diff.gitignore";
import { COMMIT_TYPES } from "../config/commit-types";

export const COMMIT_SYSTEM_PROMPT = commitMessagePrompt.replace("{{COMMIT_TYPES}}", COMMIT_TYPES.join(", ")).trim();
export const COMMIT_DIFF_IGNORE_PATTERNS = diffIgnorePatterns;
