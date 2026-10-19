import { COMMIT_DIFF_IGNORE_PATTERNS, COMMIT_SYSTEM_PROMPT, COMMIT_TYPE_PROMPT } from "../prompts";
import type { CommitType } from "../types/commit";
import type { ZapdevConfig } from "../types/config";
import { prepareCommitContext } from "./commit-context";
import { buildCommitSystemPrompt, commitResponseFormat, parseCommitResponse } from "./commit-message";

const REQUEST_TIMEOUT_MS = 25_000;

/** Generate a commit message using an OpenAI-compatible Chat Completions endpoint. */
export async function generateCommitMessage(
  diff: string,
  config: ZapdevConfig,
  type?: CommitType,
): Promise<string> {
  const systemPrompt = buildCommitSystemPrompt(COMMIT_SYSTEM_PROMPT, COMMIT_TYPE_PROMPT, type);
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: prepareCommitContext(diff, COMMIT_DIFF_IGNORE_PATTERNS),
    },
  ];

  const openRouter = new URL(config.url).hostname === "openrouter.ai";
  let response: Response;
  let body: unknown;
  let text: string;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(openRouter ? {
          "HTTP-Referer": "https://www.npmjs.com/package/zapdev",
          "X-OpenRouter-Title": "zapdev CLI",
        } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        reasoning_effort: config.effort,
        messages,
        response_format: commitResponseFormat(type),
        ...(openRouter ? { provider: { require_parameters: true } } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  } catch (error) {
    throw new Error(describeRequestError(error), { cause: error });
  }

  const apiError = serverError(body);
  const content = messageContent(body);
  if (!response.ok || apiError !== null || content === null) {
    const fallback = body === null ? text.trim() : JSON.stringify(body, null, 2);
    const diagnostic = !response.ok || apiError !== null
      ? `LLM error (HTTP ${response.status}): ${apiError ?? (fallback || "Request failed.")}`
      : `LLM returned an unexpected response shape.\nDetails: ${fallback || "Empty response."}`;
    throw new Error(config.apiKey ? diagnostic.replaceAll(config.apiKey, "[redacted]") : diagnostic);
  }
  return parseCommitResponse(content, type);
}

function describeRequestError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `LLM did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`;
  }
  return "Could not complete the LLM request. Check URL and endpoint availability.";
}

function serverError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choice: unknown =
    "choices" in body && Array.isArray(body.choices) ? body.choices[0] : null;
  const error =
    ("error" in body ? body.error : null) ??
    (choice && typeof choice === "object" && "error" in choice
      ? choice.error
      : null);
  if (!error) return null;
  if (typeof error !== "object") return String(error);
  if (!("message" in error) || typeof error.message !== "string" || !error.message.trim()) {
    return JSON.stringify(error, null, 2);
  }
  const lines = [error.message];
  if (
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    lines.push(`Code: ${error.code}`);
  }
  const metadata = "metadata" in error ? error.metadata : null;
  if (metadata && typeof metadata === "object") {
    const labels: Record<string, string> = {
      provider_name: "Provider",
      error_type: "Type",
      provider_code: "Provider code",
    };
    for (const [key, value] of Object.entries(metadata)) {
      if (
        Object.hasOwn(labels, key) &&
        (typeof value === "string" || typeof value === "number")
      ) {
        lines.push(`${labels[key]}: ${value}`);
      }
    }
    if ("raw" in metadata) {
      let raw: unknown = metadata.raw;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          raw = metadata.raw;
        }
      }
      if (typeof raw === "string") lines.push(`Details: ${raw}`);
      else if (raw && typeof raw === "object")
        lines.push(`Details: ${JSON.stringify(raw, null, 2)}`);
    }
  }
  return lines.join("\n");
}

function messageContent(body: unknown): string | null {
  if (
    !body ||
    typeof body !== "object" ||
    !("choices" in body) ||
    !Array.isArray(body.choices)
  )
    return null;
  const choice: unknown = body.choices[0];
  if (!choice || typeof choice !== "object" || !("message" in choice))
    return null;
  if ("finish_reason" in choice && choice.finish_reason !== "stop") return null;
  const message = choice.message;
  if (!message || typeof message !== "object" || !("content" in message))
    return null;
  if ("refusal" in message && message.refusal) return null;
  return typeof message.content === "string" ? message.content : null;
}
