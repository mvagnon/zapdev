import { COMMIT_TYPES } from "../config/commit-types";
import type { CommitType } from "../types/commit";

/** Force the commit type and, when requested, its breaking change marker. */
export function applyCommitType(systemPrompt: string, type: CommitType): string {
  const breaking = type.endsWith("!");
  return `${systemPrompt}\n\nThe type MUST be exactly "${breaking ? type.slice(0, -1) : type}".${breaking ? '\nInclude "!" immediately before ":" to mark a breaking change.' : ""}`;
}

/** Normalize the model's first line and enforce a selected type on valid headers, preserving breaking markers. */
export function sanitizeCommitMessage(raw: string, type?: CommitType): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  let message = firstLine.replace(/[`"]/g, "").trim();
  if (type && !validateCommitMessage(message)) {
    message = message.replace(/^[a-z]+/, type.replace(/!$/, ""));
    if (type.endsWith("!")) message = message.replace(/!?: /, "!: ");
  }
  return message;
}

/** Report all validation problems in a Conventional Commit header, allowing automatic breaking changes. */
export function validateCommitMessage(message: string, type?: CommitType): string | undefined {
  const errors: string[] = [];
  if (!message.trim()) errors.push("Message cannot be empty.");
  if (message.length > 72) errors.push(`The commit message must be at most 72 characters (received ${message.length}). Shorten it by at least ${message.length - 72} characters.`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(message)) errors.push("The commit message must be one line without control characters.");
  const match = /^([a-z]+)(?:\([^()\s]+\))?(!)?: (\S.*)$/.exec(message);
  if (message.trim() && (!match || !COMMIT_TYPES.some((supported) => supported === match[1]))) {
    errors.push(`Use type(scope)!: description, with optional scope and !. Supported types: ${COMMIT_TYPES.join(", ")}.`);
  }
  if (type && match && match[1] !== type.replace(/!$/, "")) errors.push(`The type must be exactly "${type.replace(/!$/, "")}".`);
  if (type?.endsWith("!") && match && !match[2]) errors.push('Include "!" immediately before ":" to mark a breaking change.');
  return errors.length ? errors.join("\n") : undefined;
}
