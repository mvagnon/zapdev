import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "./errors";
import type { ZapdevConfig } from "../types/config";

/** Choose subtree publication from an explicit flag or zapdev.json in the launch directory. */
export async function resolvePublishSubtree(directory: string, override?: boolean): Promise<boolean> {
  if (override !== undefined) return override;
  let content: string;
  try {
    content = await readFile(join(directory, "zapdev.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Unable to read zapdev.json: ${errorMessage(error)}`, { cause: error });
  }
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch (error) {
    throw new Error("zapdev.json must contain valid JSON.", { cause: error });
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("zapdev.json must contain an object.");
  }
  const isSubtree = (config as Record<string, unknown>).isSubtree;
  if (isSubtree !== undefined && typeof isSubtree !== "boolean") {
    throw new Error("zapdev.json isSubtree must be a boolean.");
  }
  return isSubtree === true;
}

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
