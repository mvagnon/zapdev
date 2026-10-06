import commitMessagePrompt from "./commit-message.md";
import diffIgnorePatterns from "../config/diff.gitignore";

export const COMMIT_SYSTEM_PROMPT = commitMessagePrompt.trim();
export const COMMIT_DIFF_IGNORE_PATTERNS = diffIgnorePatterns;
