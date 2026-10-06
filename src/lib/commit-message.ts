import { COMMIT_TYPES, type CommitType } from "../types/commit";

/** Force the commit type and, when requested, its breaking change marker. */
export function applyCommitType(systemPrompt: string, type: CommitType): string {
  const breaking = type.endsWith("!");
  return `${systemPrompt}\n\nThe type MUST be exactly "${breaking ? type.slice(0, -1) : type}".${breaking ? '\nInclude "!" immediately before ":" to mark a breaking change.' : ""}`;
}

/** Normalize the first line returned by the model without removing breaking change markers. */
export function sanitizeCommitMessage(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine.replace(/[`"]/g, "").trim();
}

/** Validate a Conventional Commit header, allowing automatic breaking changes with a forced base type. */
export function validateCommitMessage(message: string, type?: CommitType): string | undefined {
  if (!message.trim()) return "Message cannot be empty.";
  if (message.length > 72) return "The commit message must be at most 72 characters.";
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(message)) return "The commit message must be one line without control characters.";
  const match = /^([a-z]+)(?:\([^()\s]+\))?(!)?: (\S.*)$/.exec(message);
  if (!match || !COMMIT_TYPES.some((supported) => supported === match[1])) {
    return `Use type(scope)!: description, with optional scope and !. Supported types: ${COMMIT_TYPES.join(", ")}.`;
  }
  if (type && match[1] !== type.replace(/!$/, "")) return `The type must be exactly "${type.replace(/!$/, "")}".`;
  if (type?.endsWith("!") && !match[2]) return 'Include "!" immediately before ":" to mark a breaking change.';
  return undefined;
}
