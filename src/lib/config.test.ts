import { describe, expect, it } from "vitest";

import { DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, resolveConfig } from "./config";

describe("resolveConfig", () => {
  it("falls back to defaults when nothing is set", () => {
    expect(resolveConfig({})).toEqual({
      ollamaUrl: DEFAULT_OLLAMA_URL,
      model: DEFAULT_MODEL,
      backupModel: undefined,
      effort: DEFAULT_EFFORT,
    });
  });

  it("reads Ollama settings from the environment", () => {
    expect(
      resolveConfig({
        OLLAMA_URL: "http://host:1234",
        OLLAMA_MODEL: "my-model",
        OLLAMA_BACKUP_MODEL: "backup-model",
        OLLAMA_EFFORT: "high",
      }),
    ).toEqual({
      ollamaUrl: "http://host:1234",
      model: "my-model",
      backupModel: "backup-model",
      effort: "high",
    });
  });

  it("prefers explicit overrides over the environment", () => {
    expect(resolveConfig({ OLLAMA_MODEL: "env-model" }, { model: "flag-model" })).toEqual({
      ollamaUrl: DEFAULT_OLLAMA_URL,
      model: "flag-model",
      backupModel: undefined,
      effort: DEFAULT_EFFORT,
    });
  });

  it("ignores empty optional settings", () => {
    expect(resolveConfig({ OLLAMA_BACKUP_MODEL: " ", OLLAMA_EFFORT: "" })).toEqual({
      ollamaUrl: DEFAULT_OLLAMA_URL,
      model: DEFAULT_MODEL,
      backupModel: undefined,
      effort: DEFAULT_EFFORT,
    });
  });

  it("normalizes the Ollama URL", () => {
    expect(resolveConfig({ OLLAMA_URL: "localhost:11434" }).ollamaUrl).toBe(
      "http://localhost:11434",
    );
    expect(resolveConfig({ OLLAMA_URL: "https://host:1234/" }).ollamaUrl).toBe(
      "https://host:1234",
    );
    expect(resolveConfig({ OLLAMA_URL: " http://host:1234 " }).ollamaUrl).toBe(
      "http://host:1234",
    );
  });
});
