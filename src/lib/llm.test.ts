import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({
  COMMIT_SYSTEM_PROMPT: "Generate a commit message.",
  COMMIT_TYPE_PROMPT: "Choose a type from: feat, fix. feat: adds behavior; fix: corrects behavior.",
  COMMIT_DIFF_IGNORE_PATTERNS: "package-lock.json",
  PR_TITLE_PROMPT: "Generate a pull request title from all branch commits.",
}));

import type { ZapdevConfig } from "../types/config";
import { resolveConfig } from "./config";
import { generateCommitMessage, generatePrTitle } from "./llm";

const config: ZapdevConfig = {
  url: "http://localhost:1234/v1/chat/completions",
  model: "my-model",
  effort: "high",
};

const diff = "1\t0\tsrc/api.ts\0\0diff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n";

afterEach(() => {
  vi.restoreAllMocks();
});

it("generates a PR title from all complete commit messages without diff filtering or truncation", async () => {
  const commits = ["feat: add search\n\nSearch details.", `fix: handle empty queries\n\n${"x".repeat(13_000)}`];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: {
    content: JSON.stringify({ type: "feat", scope: null, breaking: false, description: "add search" }),
  } }] }));
  await expect(generatePrTitle(commits, config)).resolves.toBe("feat: add search");
  const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  expect(request.messages[0].content).toContain("Generate a pull request title");
  expect(request.messages[1]).toEqual({ role: "user", content: JSON.stringify(commits) });
});

describe("generateCommitMessage", () => {
  it.each([undefined, "", "  ", " test-key "])("uses the Chat Completions contract with optional authentication (%j)", async (apiKey) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ type: "fix", scope: null, breaking: false, description: "test" }) } }] }),
    );

    const resolvedConfig = resolveConfig({
      ZD_URL: config.url, ZD_MODEL: config.model, ZD_EFFORT: config.effort, ZD_API_KEY: apiKey,
    });
    await expect(generateCommitMessage(diff, resolvedConfig)).resolves.toBe("fix: test");

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      model: "my-model",
      stream: false,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: expect.stringContaining("Generate a commit message.") },
        { role: "user", content: 'Changed files:\n+1 -0 "src/api.ts"\n\ndiff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n' },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "commit_message", strict: true,
          schema: {
            type: "object", additionalProperties: false,
            properties: {
              description: { type: "string", pattern: expect.any(String) },
              scope: { type: ["string", "null"], pattern: expect.any(String) },
              type: { type: "string", enum: ["feat", "fix", "deps", "chore", "docs", "style", "refactor", "perf", "test", "build", "ci", "revert"] },
              breaking: { type: "boolean" },
            },
            required: ["description", "scope", "type", "breaking"],
          },
        },
      },
    });
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(request.messages[0].content).toContain("Choose a type from: feat, fix.");
    expect(request.messages[0].content).toContain('"type":"fix"');
    expect(request.messages[0].content).toContain('"breaking":false');
  });

  it("reports API errors without retrying another model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { message: "model unavailable" } }, { status: 503 }),
    );
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("LLM error (HTTP 503): model unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Bad Gateway", "Bad Gateway"],
    ["<html><body>Bad Gateway</body></html>", "<html><body>Bad Gateway</body></html>"],
    [JSON.stringify({ detail: "Provider unavailable" }), JSON.stringify({ detail: "Provider unavailable" }, null, 2)],
    ["", "Request failed."],
  ])("preserves unknown error responses with their HTTP status (%s)", async (body, details) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 502 }));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow(`LLM error (HTTP 502): ${details}`);
  });

  it.each([
    "Provider unavailable",
    { detail: "Provider unavailable", type: "overloaded" },
  ])("preserves unknown error payloads even with HTTP 200 (%j)", async (error) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error, choices: [{ message: { content: "fix: partial output" } }],
    }));
    const details = typeof error === "string" ? error : JSON.stringify(error, null, 2);
    await expect(generateCommitMessage(diff, config)).rejects.toThrow(`LLM error (HTTP 200): ${details}`);
  });

  it.each([
    ["https://openrouter.ai/api/v1/chat/completions", true],
    ["https://openrouter.ai.example.com/chat/completions", false],
  ])("sends attribution only to OpenRouter (%s)", async (url, attributed) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ type: "fix", scope: null, breaking: false, description: "test" }) } }] }),
    );
    await generateCommitMessage(diff, { ...config, url, apiKey: "test-key" });
    expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer test-key",
      ...(attributed ? {
        "HTTP-Referer": "https://mvagnon.dev/zapdev-cli",
        "X-OpenRouter-Title": "zapdev CLI",
      } : {}),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).provider).toEqual(
      attributed ? { require_parameters: true } : undefined,
    );
  });

  it.each([
    [400, "top-level", JSON.stringify({ error: { message: "Unsupported effort", code: "invalid_parameter" } })],
    [200, "top-level", { error: { message: "Unsupported effort", code: "invalid_parameter" } }],
    [200, "choice", "Unsupported effort"],
  ])("reports provider details without accepting partial output (%s, %s)", async (status, location, raw) => {
    const error = {
      code: 400,
      message: "Provider returned error",
      metadata: {
        provider_name: "Test provider",
        error_type: "invalid_request",
        provider_code: "invalid_parameter",
        raw,
      },
    };
    const choice = { message: { content: "fix: partial output" }, finish_reason: "error" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(
      location === "choice" ? { error: null, choices: [{ ...choice, error }] } : { error, choices: [choice] },
      { status },
    ));
    const details = typeof raw === "string" && location === "choice"
      ? raw
      : JSON.stringify({ error: { message: "Unsupported effort", code: "invalid_parameter" } }, null, 2);
    await expect(generateCommitMessage(diff, config)).rejects.toThrow(
      `LLM error (HTTP ${status}): Provider returned error\nCode: 400\nProvider: Test provider\nType: invalid_request\nProvider code: invalid_parameter\nDetails: ${details}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [JSON.stringify({ error: { message: "Invalid test-secret", metadata: { raw: "Rejected Bearer test-secret" } } }),
      "Invalid [redacted]\nDetails: Rejected Bearer [redacted]"],
    ["Invalid test-secret", "Invalid [redacted]"],
    [JSON.stringify({ detail: "Invalid test-secret" }), JSON.stringify({ detail: "Invalid [redacted]" }, null, 2)],
  ])("does not expose the API key echoed in provider errors (%s)", async (body, details) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 401 }));
    await expect(generateCommitMessage(diff, { ...config, apiKey: "test-secret" })).rejects.toThrow(
      `LLM error (HTTP 401): ${details}`,
    );
  });

  it.each([null, {}, { choices: [] }, { choices: [null] }, { choices: [{ message: { content: null } }] }])(
    "rejects malformed responses: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(generateCommitMessage(diff, config)).rejects.toThrow(
        `LLM returned an unexpected response shape.\nDetails: ${JSON.stringify(body, null, 2)}`,
      );
    },
  );

  it("reports request timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("within 25s");
  });

  it("reports network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("Check URL and endpoint availability");
  });

  it.each([null, "api"])("assembles the automatic type, scope=%s and breaking marker locally", async (scope) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: {
      content: JSON.stringify({ type: "feat", scope, breaking: true, description: "remove the old endpoint" }),
    } }] }));
    await expect(generateCommitMessage(diff, config)).resolves.toBe(`feat${scope ? `(${scope})` : ""}!: remove the old endpoint`);
  });

  it.each([
    ["fix", null, "fix"], ["fix", "api", "fix(api)"],
    ["feat!", null, "feat!"], ["feat!", "api", "feat(api)!"],
  ] as const)("requests a nullable scope and description when type=%s and scope=%s", async (type, scope, header) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: {
      content: JSON.stringify({ scope, description: "repair the endpoint" }),
    } }] }));
    await expect(generateCommitMessage(diff, config, type)).resolves.toBe(`${header}: repair the endpoint`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(request.response_format.json_schema.schema).toEqual({
      type: "object", additionalProperties: false,
      properties: {
        description: { type: "string", pattern: expect.any(String) },
        scope: { type: ["string", "null"], pattern: expect.any(String) },
      },
      required: ["description", "scope"],
    });
    expect(request.messages[0].content).toContain(`The commit type is already set to "${type}"`);
    expect(request.messages[0].content).toContain("Return only the scope and description fields");
    expect(request.messages[0].content).toContain('"description":"summarize the main change","scope":null');
    expect(request.messages[0].content).not.toContain("Choose a type");
    expect(request.messages[0].content).not.toContain("feat: adds behavior");
  });

  it.each(["fix: free text", "{", "null", "[]",
    JSON.stringify({ type: "banana", scope: null, breaking: false, description: "test" }),
    JSON.stringify({ type: "fix", scope: "bad scope", breaking: false, description: "test" }),
    JSON.stringify({ type: "fix", scope: "api)", breaking: false, description: "test" }),
    JSON.stringify({ type: "fix", scope: null, breaking: "false", description: "test" }),
    JSON.stringify({ type: "fix", scope: null, breaking: false, description: "" }),
    JSON.stringify({ type: "fix", scope: null, breaking: false, description: "  " }),
    JSON.stringify({ type: "fix", scope: null, breaking: false, description: "first\nsecond" }),
    JSON.stringify({ type: "fix", scope: null, breaking: false, description: "test\u001b[31m" }),
    JSON.stringify({ type: "fix", scope: null, description: "test" }),
    JSON.stringify({ type: "fix", scope: null, breaking: false, description: "test", extra: true }),
  ])("rejects an endpoint that does not honor the schema without retrying: %s", async (content) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content } }] }));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("must support strict JSON Schema structured outputs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["length", "content_filter"])("does not accept incomplete structured output (%s)", async (finish_reason) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ finish_reason, message: {
      content: JSON.stringify({ type: "fix", scope: null, breaking: false, description: "test" }),
    } }] }));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("unexpected response shape");
  });

  it("does not accept a refusal even when content is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: {
      refusal: "Cannot comply", content: JSON.stringify({ description: "test" }),
    } }] }));
    await expect(generateCommitMessage(diff, config, "fix")).rejects.toThrow("unexpected response shape");
  });

  it.each([
    { type: "feat", scope: null, description: "test" },
    { description: "test" },
    { scope: "bad scope", description: "test" },
    { scope: 42, description: "test" },
  ])("rejects fields that violate the forced-type schema: %j", async (value) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: {
      content: JSON.stringify(value),
    } }] }));
    await expect(generateCommitMessage(diff, config, "fix")).rejects.toThrow("must support strict JSON Schema structured outputs");
  });

  it("preserves quotes, backticks and descriptions above the 72-character target", async () => {
    const description = `handle \`code\` and "quotes" ${"x".repeat(100)}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: {
      content: JSON.stringify({ scope: null, description }),
    } }] }));
    await expect(generateCommitMessage(diff, config, "fix")).resolves.toBe(`fix: ${description}`);
  });
});
