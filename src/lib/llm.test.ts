import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({
  COMMIT_SYSTEM_PROMPT: "Generate a commit message.",
  COMMIT_DIFF_IGNORE_PATTERNS: "package-lock.json",
}));

import type { ZapdevConfig } from "../types/config";
import { resolveConfig } from "./config";
import { InvalidCommitMessageError } from "./errors";
import { generateCommitMessage } from "./llm";

const config: ZapdevConfig = {
  url: "http://localhost:1234/v1/chat/completions",
  model: "my-model",
  effort: "high",
};

const diff = "1\t0\tsrc/api.ts\0\0diff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateCommitMessage", () => {
  it.each([undefined, "", "  ", " test-key "])("uses the Chat Completions contract with optional authentication (%j)", async (apiKey) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: '`fix: test`\nExplanation' } }] }),
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
      body: JSON.stringify({
        model: "my-model",
        stream: false,
        reasoning_effort: "high",
        messages: [
          { role: "system", content: "Generate a commit message." },
          { role: "user", content: 'Changed files:\n+1 -0 "src/api.ts"\n\ndiff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n' },
        ],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("reports API errors without retrying another model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { message: "model unavailable" } }, { status: 503 }),
    );
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("LLM error (HTTP 503): model unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the HTTP status when the error response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("HTTP 502");
  });

  it.each([
    ["https://openrouter.ai/api/v1/chat/completions", true],
    ["https://openrouter.ai.example.com/chat/completions", false],
  ])("sends attribution only to OpenRouter (%s)", async (url, attributed) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "fix: test" } }] }),
    );
    await generateCommitMessage(diff, { ...config, url, apiKey: "test-key" });
    expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer test-key",
      ...(attributed ? {
        "HTTP-Referer": "https://www.npmjs.com/package/zapdev",
        "X-OpenRouter-Title": "zapdev CLI",
      } : {}),
    });
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

  it("does not expose the API key echoed in provider errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { message: "Invalid test-secret", metadata: { raw: "Rejected Bearer test-secret" } },
    }, { status: 401 }));
    await expect(generateCommitMessage(diff, { ...config, apiKey: "test-secret" })).rejects.toThrow(
      "LLM error (HTTP 401): Invalid [redacted]\nDetails: Rejected Bearer [redacted]",
    );
  });

  it.each([null, {}, { choices: [] }, { choices: [null] }, { choices: [{ message: { content: null } }] }])(
    "rejects malformed responses: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(generateCommitMessage(diff, config)).rejects.toThrow("unexpected response shape");
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

  it.each([undefined, "feat"] as const)("accepts a model-selected breaking change when type=%s", async (type) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "feat(api)!: remove the old endpoint" } }] }),
    );
    await expect(generateCommitMessage(diff, config, type)).resolves.toBe("feat(api)!: remove the old endpoint");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["fix", "ci(release): use an optional PR number", "fix(release): use an optional PR number"],
    ["fix", "feat(api)!: remove the old endpoint", "fix(api)!: remove the old endpoint"],
    ["feat!", "fix: repair the endpoint", "feat!: repair the endpoint"],
    ["feat!", "fix(api): repair the endpoint", "feat(api)!: repair the endpoint"],
    ["feat!", "fix(api)!: remove the old endpoint", "feat(api)!: remove the old endpoint"],
  ] as const)("enforces type=%s without retrying a valid header", async (type, content, expected) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ choices: [{ message: { content } }] }),
    );
    await expect(generateCommitMessage(diff, config, type)).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([68, 200])("accepts long messages and enforces the selected type without retrying (%i)", async (length) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ choices: [{ message: { content: `ci: ${"x".repeat(length)}` } }] }));

    await expect(generateCommitMessage(diff, config, "feat!")).resolves.toBe(`feat!: ${"x".repeat(length)}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, "banana: invalid"], [undefined, "feat: "],
    ["feat!", "banana: invalid"], ["feat", "fix: "],
  ] as const)("retries an invalid message once (type=%s, message=%s)", async (type, invalid) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: invalid } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "feat(api)!: remove the old endpoint" } }] }));

    await expect(generateCommitMessage(diff, config, type)).resolves.toBe("feat(api)!: remove the old endpoint");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry: { messages: { role: string; content: string }[] } = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(retry.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: invalid },
      { role: "user", content: expect.stringContaining("Invalid commit message:") },
    ]));
  });

  it("stops after two invalid messages without retrying indefinitely", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: "banana: invalid" } }] }),
    );
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("invalid commit message after two attempts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows both rejected responses safely and keeps the full raw response in the conversation", async () => {
    const message = `feat: ${"x".repeat(90)}\tmore`;
    const raw = `  \`${message}\`\n${"Explanation. ".repeat(30)}\u001b[31m`;
    const second = "banana: invalid";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: raw } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: second } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "fix: test" } }] }));

    const error: unknown = await generateCommitMessage(diff, config).catch((error: unknown) => error);
    if (!(error instanceof InvalidCommitMessageError)) throw new Error("Expected an invalid commit message error.");
    expect(error.message).toContain(`Rejected response 1 (${raw.length} characters): ${JSON.stringify(raw)}`);
    expect(error.message).toContain(`Validated message (${message.length} characters): ${JSON.stringify(message)}`);
    expect(error.message).toContain("without control characters");
    expect(error.message).toContain(`Rejected response 2 (${second.length} characters): ${JSON.stringify(second)}`);
    expect(error.message).not.toContain("\u001b");

    await expect(error.retry()).resolves.toBe("fix: test");
    for (const call of fetchMock.mock.calls.slice(1)) {
      const request: { messages: { role: string; content: string }[] } = JSON.parse(call[1]!.body as string);
      expect(request.messages[2]).toEqual({ role: "assistant", content: raw });
      expect(request.messages[3]!.content).toContain("without control characters");
    }
  });

  it("sends all validation problems and retains the conversation when retrying", async () => {
    const invalid = `banana: ${"x".repeat(70)}\tmore`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: invalid } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: invalid } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "feat!: remove the old endpoint" } }] }));

    const error: unknown = await generateCommitMessage(diff, config, "feat!").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(InvalidCommitMessageError);
    if (!(error instanceof InvalidCommitMessageError)) throw new Error("Expected an invalid commit message error.");
    await expect(error.retry()).resolves.toBe("feat!: remove the old endpoint");

    const correction: { messages: { role: string; content: string }[] } = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(correction.messages.at(-1)!.content).toContain("without control characters");
    expect(correction.messages.at(-1)!.content).toContain("Supported types:");
    expect(correction.messages.at(-1)!.content).toContain('The type must be exactly "feat".');
    expect(correction.messages.at(-1)!.content).toContain('Include "!" immediately before ":"');
    const retry: { messages: { role: string; content: string }[] } = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string);
    expect(retry.messages.slice(0, correction.messages.length)).toEqual(correction.messages);
    expect(retry.messages).toHaveLength(6);
  });
});
