import type { CommitType } from "../types/commit";

export function applyCommitType(systemPrompt: string, type: CommitType): string {
  return `${systemPrompt}\n\nThe type MUST be exactly "${type}".`;
}

export const MAX_DIFF_CHARS = 12_000;

export function truncateDiff(diff: string, max: number = MAX_DIFF_CHARS): string {
  return diff.length > max ? diff.slice(0, max) : diff;
}

export function sanitizeCommitMessage(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine.replace(/[`"]/g, "").trim();
}
