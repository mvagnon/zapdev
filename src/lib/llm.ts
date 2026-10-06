import { COMMIT_DIFF_IGNORE_PATTERNS, COMMIT_SYSTEM_PROMPT } from "../prompts";
import type { CommitType } from "../types/commit";
import type { ZapdevConfig } from "../types/config";
import { prepareCommitContext } from "./commit-context";
import { applyCommitType, sanitizeCommitMessage, validateCommitMessage } from "./commit-message";

const REQUEST_TIMEOUT_MS = 25_000;

/** Generate a commit message using an OpenAI-compatible Chat Completions endpoint. */
export async function generateCommitMessage(
  diff: string,
  config: ZapdevConfig,
  type?: CommitType,
): Promise<string> {
  const systemPrompt = type ? applyCommitType(COMMIT_SYSTEM_PROMPT, type) : COMMIT_SYSTEM_PROMPT;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prepareCommitContext(diff, COMMIT_DIFF_IGNORE_PATTERNS) },
  ];

  let validationError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          reasoning_effort: config.effort,
          messages,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    } catch (error) {
      throw new Error(describeRequestError(error), { cause: error });
    }

    if (!response.ok) {
      throw new Error(`LLM error: ${serverError(body) ?? `HTTP ${response.status}`}`);
    }

    const content = messageContent(body);
    if (content === null) throw new Error("LLM returned an unexpected response shape.");
    const message = sanitizeCommitMessage(content);
    const error = validateCommitMessage(message, type);
    if (!error) return message;
    validationError = error;
    messages.push(
      { role: "assistant", content: message.slice(0, 200) },
      { role: "user", content: `Invalid commit message: ${error} Return only a corrected commit message for the same changes.` },
    );
  }
  throw new Error(`LLM returned an invalid commit message after two attempts: ${validationError}`);
}

function describeRequestError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `LLM did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`;
  }
  return "Could not complete the LLM request. Check URL and endpoint availability.";
}

function serverError(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = body.error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return null;
}

function messageContent(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) return null;
  const choice: unknown = body.choices[0];
  if (!choice || typeof choice !== "object" || !("message" in choice)) return null;
  const message = choice.message;
  if (!message || typeof message !== "object" || !("content" in message)) return null;
  return typeof message.content === "string" ? message.content : null;
}
