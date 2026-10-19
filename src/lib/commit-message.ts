import { COMMIT_TYPES } from "../config/commit-types";
import type { CommitType } from "../types/commit";

const CONTROL_CHARACTERS = "\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029";
const DESCRIPTION_PATTERN = `^[^\\s${CONTROL_CHARACTERS}][^${CONTROL_CHARACTERS}]*$`;
const SCOPE_PATTERN = `^[^()\\s${CONTROL_CHARACTERS}]+$`;
const STRUCTURED_OUTPUT_ERROR = "LLM returned a response that does not match the requested schema. The endpoint and model must support strict JSON Schema structured outputs.";

/** Define the structured response, omitting type and breaking when the user supplies them. */
export function commitResponseFormat(type?: CommitType) {
  const properties = {
    description: { type: "string", pattern: DESCRIPTION_PATTERN },
    scope: { type: ["string", "null"], pattern: SCOPE_PATTERN },
    ...(!type ? {
      type: { type: "string", enum: COMMIT_TYPES },
      breaking: { type: "boolean" },
    } : {}),
  };
  return {
    type: "json_schema",
    json_schema: {
      name: "commit_message",
      strict: true,
      schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

/** Check the endpoint honors the schema and assemble the Conventional Commit locally. */
export function parseCommitResponse(content: string, type?: CommitType): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(STRUCTURED_OUTPUT_ERROR, { cause: error });
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== (type ? 2 : 4) ||
    !("description" in value) || typeof value.description !== "string" ||
    !new RegExp(DESCRIPTION_PATTERN, "u").test(value.description) ||
    !("scope" in value) || (value.scope !== null && (typeof value.scope !== "string" || !new RegExp(SCOPE_PATTERN, "u").test(value.scope)))
  ) throw new Error(STRUCTURED_OUTPUT_ERROR);
  const scope = value.scope ? `(${value.scope.trim()})` : "";
  if (type) return `${type.replace(/!$/, "")}${scope}${type.endsWith("!") ? "!" : ""}: ${value.description.trim()}`;
  if (
    !("type" in value) || !COMMIT_TYPES.some((supported) => supported === value.type) ||
    !("breaking" in value) || typeof value.breaking !== "boolean"
  ) throw new Error(STRUCTURED_OUTPUT_ERROR);
  return `${value.type}${scope}${value.breaking ? "!" : ""}: ${value.description.trim()}`;
}

/** Report all validation problems in a Conventional Commit header, allowing automatic breaking changes. */
export function validateCommitMessage(message: string, type?: CommitType): string | undefined {
  const errors: string[] = [];
  if (!message.trim()) errors.push("Message cannot be empty.");
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(message)) errors.push("The commit message must be one line without control characters.");
  const match = /^([a-z]+)(?:\([^()\s]+\))?(!)?: (\S.*)$/.exec(message);
  if (message.trim() && (!match || !COMMIT_TYPES.some((supported) => supported === match[1]))) {
    errors.push(`Use type(scope)!: description, with optional scope and !. Supported types: ${COMMIT_TYPES.join(", ")}.`);
  }
  if (type && match && match[1] !== type.replace(/!$/, "")) errors.push(`The type must be exactly "${type.replace(/!$/, "")}".`);
  if (type?.endsWith("!") && match && !match[2]) errors.push('Include "!" immediately before ":" to mark a breaking change.');
  return errors.length ? errors.join("\n") : undefined;
}
