import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({ COMMIT_SYSTEM_PROMPT: "Generate a commit message." }));

import type { ZapdevConfig } from "../types/config";
import { generateCommitMessage } from "./llm";

const config: ZapdevConfig = {
  url: "http://localhost:1234/v1/chat/completions",
  model: "my-model",
  effort: "high",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateCommitMessage", () => {
  it("uses the exact endpoint and Chat Completions contract, then sanitizes the result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: '`fix: test`\nExplanation' } }] }),
    );

    await expect(generateCommitMessage("diff", config)).resolves.toBe("fix: test");

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "my-model",
        stream: false,
        reasoning_effort: "high",
        messages: [
          { role: "system", content: "Generate a commit message." },
          { role: "user", content: "diff" },
        ],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("reports API errors without retrying another model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { message: "model unavailable" } }, { status: 503 }),
    );
    await expect(generateCommitMessage("diff", config)).rejects.toThrow("LLM error: model unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the HTTP status when the error response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(generateCommitMessage("diff", config)).rejects.toThrow("HTTP 502");
  });

  it.each([null, {}, { choices: [] }, { choices: [null] }, { choices: [{ message: { content: null } }] }])(
    "rejects malformed responses: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(generateCommitMessage("diff", config)).rejects.toThrow("unexpected response shape");
    },
  );

  it("reports request timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(generateCommitMessage("diff", config)).rejects.toThrow("within 25s");
  });

  it("reports network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(generateCommitMessage("diff", config)).rejects.toThrow("Check URL and endpoint availability");
  });
});
