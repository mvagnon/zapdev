import type { CommitType } from "../types/commit";

/** Force the commit type and, when requested, its breaking change marker. */
export function applyCommitType(systemPrompt: string, type: CommitType): string {
  const breaking = type.endsWith("!");
  return `${systemPrompt}\n\nThe type MUST be exactly "${breaking ? type.slice(0, -1) : type}".${breaking ? '\nInclude "!" immediately before ":" to mark a breaking change.' : ""}`;
}

export const MAX_DIFF_CHARS = 12_000;

export function truncateDiff(diff: string, max: number = MAX_DIFF_CHARS): string {
  return diff.length > max ? diff.slice(0, max) : diff;
}

export function sanitizeCommitMessage(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine.replace(/[`"]/g, "").trim();
}
