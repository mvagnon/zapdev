import type { ZapdevConfig } from "../types/config";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_MODEL = "deepseek-v4-flash:cloud";
export const DEFAULT_EFFORT = "low";

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ZapdevConfig> = {},
): ZapdevConfig {
  return {
    ollamaUrl: normalizeBaseUrl(overrides.ollamaUrl ?? env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL),
    model: overrides.model ?? env.OLLAMA_MODEL ?? DEFAULT_MODEL,
    backupModel: overrides.backupModel ?? optionalValue(env.OLLAMA_BACKUP_MODEL),
    effort: overrides.effort ?? optionalValue(env.OLLAMA_EFFORT) ?? DEFAULT_EFFORT,
  };
}

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

// The Ollama SDK accepted scheme-less hosts (e.g. "localhost:11434"); keep that contract.
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}
