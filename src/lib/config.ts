import type { ZapdevConfig } from "../types/config";

/** Resolve the per-hook deadline in milliseconds from ZD_HOOK_TIMEOUT (seconds). */
export function resolveHookTimeout(env: Record<string, string | undefined> = process.env): number {
  const timeout = Number(env.ZD_HOOK_TIMEOUT ?? 60) * 1_000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new Error("ZD_HOOK_TIMEOUT must be a number of seconds between 0.001 and 2147483.647.");
  }
  return timeout;
}

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
