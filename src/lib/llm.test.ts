import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({
  COMMIT_SYSTEM_PROMPT: "Generate a commit message.",
  COMMIT_DIFF_IGNORE_PATTERNS: "package-lock.json",
}));

import type { ZapdevConfig } from "../types/config";
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
  it("uses the exact endpoint and Chat Completions contract, then sanitizes the result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: '`fix: test`\nExplanation' } }] }),
    );

    await expect(generateCommitMessage(diff, config)).resolves.toBe("fix: test");

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("LLM error: model unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the HTTP status when the error response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(generateCommitMessage(diff, config)).rejects.toThrow("HTTP 502");
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
    [undefined, "banana: invalid"], [undefined, "feat: "], [undefined, `feat: ${"x".repeat(70)}`],
    ["feat!", "feat: remove the endpoint"], ["feat", "fix: repair the endpoint"],
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
