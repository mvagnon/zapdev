import { COMMIT_SYSTEM_PROMPT } from "../prompts";
import type { CommitType } from "../types/commit";
import type { ZapdevConfig } from "../types/config";
import { applyCommitType, sanitizeCommitMessage, truncateDiff } from "./commit-message";

const REQUEST_TIMEOUT_MS = 25_000;

/** Generate a commit message using an OpenAI-compatible Chat Completions endpoint. */
export async function generateCommitMessage(
  diff: string,
  config: ZapdevConfig,
  type?: CommitType,
): Promise<string> {
  const systemPrompt = type ? applyCommitType(COMMIT_SYSTEM_PROMPT, type) : COMMIT_SYSTEM_PROMPT;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: truncateDiff(diff) },
  ];

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
  return sanitizeCommitMessage(content);
}

function describeRequestError(error: unknown): string {
  if (errorName(error) === "TimeoutError") {
    return `LLM did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`;
  }
  return "Could not complete the LLM request. Check URL and endpoint availability.";
}

function errorName(error: unknown): string | null {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return null;
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
