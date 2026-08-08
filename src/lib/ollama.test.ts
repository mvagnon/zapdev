import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../prompts", () => ({ COMMIT_SYSTEM_PROMPT: "Generate a commit message." }));

import type { ZapdevConfig } from "../types/config";
import { generateCommitMessage } from "./ollama";

const config: ZapdevConfig = {
  ollamaUrl: "http://localhost:11434",
  model: "primary-model",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateCommitMessage", () => {
  it("passes the configured effort to Ollama", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(success("fix: test"));

    await expect(generateCommitMessage("diff", { ...config, effort: "high" })).resolves.toBe(
      "fix: test",
    );

    expect(requestBody(fetchMock, 0)).toMatchObject({
      model: "primary-model",
      think: "high",
    });
  });

  it("retries generation with the backup model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(errorResponse("primary unavailable"))
      .mockResolvedValueOnce(success("fix: fallback"));

    await expect(
      generateCommitMessage("diff", { ...config, backupModel: "backup-model" }),
    ).resolves.toBe("fix: fallback");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0)).toMatchObject({ model: "primary-model" });
    expect(requestBody(fetchMock, 1)).toMatchObject({ model: "backup-model" });
  });

  it("reports failures from both models", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(errorResponse("primary unavailable"))
      .mockResolvedValueOnce(errorResponse("backup unavailable"));

    await expect(
      generateCommitMessage("diff", { ...config, backupModel: "backup-model" }),
    ).rejects.toThrow(
      "Primary model failed: Ollama error: primary unavailable Backup model failed: Ollama error: backup unavailable",
    );
  });
});

function success(content: string): Response {
  return Response.json({ message: { content } });
}

function errorResponse(error: string): Response {
  return Response.json({ error }, { status: 500 });
}

function requestBody(fetchMock: ReturnType<typeof vi.spyOn>, index: number): Record<string, unknown> {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(body) as Record<string, unknown>;
}
