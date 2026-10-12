import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({
  COMMIT_SYSTEM_PROMPT: "Generate a commit message.",
  COMMIT_DIFF_IGNORE_PATTERNS: "package-lock.json",
}));

import type { ZapdevConfig } from "../types/config";
import { resolveConfig } from "./config";
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
      `LLM error (HTTP ${status}): Provider returned error\nCode: 400\nProvider: Test provider\nType: invalid_request\nProvider code: invalid_parameter\nDetails:\n${details}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose the API key echoed in provider errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { message: "Invalid test-secret", metadata: { raw: "Rejected Bearer test-secret" } },
    }, { status: 401 }));
    await expect(generateCommitMessage(diff, { ...config, apiKey: "test-secret" })).rejects.toThrow(
      "LLM error (HTTP 401): Invalid [redacted]\nDetails:\nRejected Bearer [redacted]",
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

  it("revalidates the length after enforcing the selected type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: `ci: ${"x".repeat(68)}` } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "feat: update automation" } }] }));

    await expect(generateCommitMessage(diff, config, "feat!")).resolves.toBe("feat!: update automation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]!.body).toContain("at most 72 characters");
  });

  it.each([
    [undefined, "banana: invalid"], [undefined, "feat: "], [undefined, `feat: ${"x".repeat(70)}`],
    ["feat!", "banana: invalid"], ["feat", "fix: "],
  ] as const)("retries an invalid message once (type=%s, message=%s)", async (type, invalid) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: invalid } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "feat(api)!: remove the old endpoint" } }] }));

    await expect(generateCommitMessage(diff, config, type)).resolves.toBe("feat(api)!: remove the old endpoint");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry: { messages: { role: string; content: string }[] } = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(retry.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: invalid.trim() },
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
});
