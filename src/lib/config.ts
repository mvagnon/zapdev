import type { ZapdevConfig } from "../types/config";

/** Resolve required settings, with CLI overrides taking precedence over environment variables. */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ZapdevConfig> = {},
): ZapdevConfig {
  const config = {
    url: (overrides.url ?? env.ZD_URL)?.trim() ?? "",
    model: (overrides.model ?? env.ZD_MODEL)?.trim() ?? "",
    effort: (overrides.effort ?? env.ZD_EFFORT)?.trim() ?? "",
  };
  for (const [key, value] of Object.entries(config)) {
    if (!value) throw new Error(`Set ZD_${key.toUpperCase()} or --${key} before generating a commit message.`);
  }

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("URL must be a complete HTTP(S) Chat Completions endpoint.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must be a complete HTTP(S) Chat Completions endpoint.");
  }
  return config;
}
