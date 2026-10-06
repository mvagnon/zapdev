import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { errorMessage } from "./errors";
import type { ProjectConfig, SubtreeMapping, ZapdevConfig } from "../types/config";

/** Read project settings and validate their subtree mapping without discarding other options. */
export async function readProjectConfig(directory: string): Promise<ProjectConfig> {
  let content: string;
  try {
    content = await readFile(join(directory, "zapdev.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
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
  const settings = config as Record<string, unknown>;
  if (settings.isSubtree !== undefined) {
    throw new Error("zapdev.json isSubtree is no longer supported; use a subtrees folder-to-remote mapping.");
  }
  const subtrees = settings.subtrees;
  if (subtrees === undefined) return settings as ProjectConfig;
  if (typeof subtrees !== "object" || subtrees === null || Array.isArray(subtrees)) {
    throw new Error("zapdev.json subtrees must be a folder-to-remote object.");
  }
  for (const [prefix, remote] of Object.entries(subtrees as Record<string, unknown>)) {
    if (prefix !== prefix.trim() || isAbsolute(prefix) || prefix.includes("\\")
      || prefix.split("/").some((part) => ["", ".", "..", ".git"].includes(part))) {
      throw new Error(`zapdev.json subtree folder "${prefix}" must be a repository-relative directory.`);
    }
    if (typeof remote !== "string" || !remote || /\s/.test(remote) || remote.startsWith("-")) {
      throw new Error(`zapdev.json subtree "${prefix}" must map to a nonempty Git remote name.`);
    }
  }
  return settings as ProjectConfig;
}

/** Read the subtree mapping in the launch directory's zapdev.json. */
export async function resolveSubtrees(directory: string): Promise<SubtreeMapping> {
  return (await readProjectConfig(directory)).subtrees ?? {};
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
