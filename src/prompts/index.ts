import commitMessagePrompt from "./commit-message.md";
import commitTypePrompt from "./commit-type.md";
import prTitlePrompt from "./pr-title.md";
import diffIgnorePatterns from "../config/diff.gitignore";
import { COMMIT_TYPES } from "../config/commit-types";

export const COMMIT_SYSTEM_PROMPT = commitMessagePrompt.trim();
export const COMMIT_TYPE_PROMPT = commitTypePrompt.replace("{{COMMIT_TYPES}}", COMMIT_TYPES.join(", ")).trim();
export const COMMIT_DIFF_IGNORE_PATTERNS = diffIgnorePatterns;
export const PR_TITLE_PROMPT = prTitlePrompt.trim();
