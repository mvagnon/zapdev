import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveConfig, resolveHookTimeout, resolveSubtrees } from "./config";

const env = { ZD_URL: "http://localhost:1234/v1/chat/completions", ZD_MODEL: "my-model", ZD_EFFORT: "low" };

describe("resolveSubtrees", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "zapdev-config-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("defaults to classic push and only reads zapdev.json in the launch directory", async () => {
    await expect(resolveSubtrees(directory)).resolves.toEqual({});
    const subtrees = { "apps/ui": "frontend", "services/api": "backend" };
    await writeFile(join(directory, "zapdev.json"), JSON.stringify({ subtrees }));
    await expect(resolveSubtrees(directory)).resolves.toEqual(subtrees);
    const child = join(directory, "child");
    await mkdir(child);
    await expect(resolveSubtrees(child)).resolves.toEqual({});
  });

  it.each([{}, { subtrees: {} }])("uses classic push for an absent or empty mapping: %j", async (config) => {
    await writeFile(join(directory, "zapdev.json"), JSON.stringify(config));
    await expect(resolveSubtrees(directory)).resolves.toEqual({});
  });

  it.each([
    '{', 'null', '[]', '{"isSubtree":true}', '{"isSubtree":false}',
    '{"subtrees":null}', '{"subtrees":true}', '{"subtrees":[]}',
    '{"subtrees":{"apps/ui":null}}', '{"subtrees":{"apps/ui":""}}',
    '{"subtrees":{"apps/ui":"--all"}}', '{"subtrees":{"apps/ui":" remote "}}',
    '{"subtrees":{"":"front"}}', '{"subtrees":{".":"front"}}',
    '{"subtrees":{"../outside":"front"}}', '{"subtrees":{"apps/../ui":"front"}}',
    '{"subtrees":{"/absolute":"front"}}', '{"subtrees":{".git":"front"}}',
  ])(
    "rejects invalid configuration before choosing a push mode: %s", async (content) => {
      await writeFile(join(directory, "zapdev.json"), content);
      await expect(resolveSubtrees(directory)).rejects.toThrow("zapdev.json");
    });

  it("does not treat unreadable configuration as a missing file", async () => {
    await mkdir(join(directory, "zapdev.json"));
    await expect(resolveSubtrees(directory)).rejects.toThrow("Unable to read zapdev.json");
  });
});

it("defaults hook deadlines to 60 seconds and accepts a valid environment override", () => {
  expect(resolveHookTimeout({})).toBe(60_000);
  expect(resolveHookTimeout({ ZD_HOOK_TIMEOUT: " 120 " })).toBe(120_000);
  expect(resolveHookTimeout({ ZD_HOOK_TIMEOUT: "0.05" })).toBe(50);
  for (const value of ["", " ", "0", "-1", "invalid", "Infinity", "2147484", "0.0001"]) {
    expect(() => resolveHookTimeout({ ZD_HOOK_TIMEOUT: value })).toThrow("ZD_HOOK_TIMEOUT");
  }
});

describe("resolveConfig", () => {
  it("requires explicit configuration instead of defaults or legacy settings", () => {
    expect(() => resolveConfig({})).toThrow("Set ZD_URL");
    expect(() => resolveConfig({
      OLLAMA_URL: env.ZD_URL, OLLAMA_MODEL: env.ZD_MODEL, OLLAMA_EFFORT: env.ZD_EFFORT,
      URL: env.ZD_URL, MODEL: env.ZD_MODEL, EFFORT: env.ZD_EFFORT,
    })).toThrow("Set ZD_URL");
  });

  it("reads and trims settings without changing the endpoint path or query", () => {
    const url = "https://host/custom/chat/?version=1";
    expect(resolveConfig({ ZD_URL: ` ${url} `, ZD_MODEL: " my-model ", ZD_EFFORT: " low " })).toEqual({
      url, model: "my-model", effort: "low",
    });
  });

  it("prefers explicit overrides over the environment", () => {
    const overrides = { url: "https://host/chat/completions", model: "flag-model", effort: "high" };
    expect(resolveConfig(env, overrides)).toEqual(overrides);
    expect(resolveConfig({}, overrides)).toEqual(overrides);
  });

  it.each(["ZD_URL", "ZD_MODEL", "ZD_EFFORT"])("rejects missing or blank %s", (key) => {
    for (const value of [undefined, "", "  "]) {
      expect(() => resolveConfig({ ...env, [key]: value })).toThrow(`Set ${key}`);
    }
  });

  it("rejects an empty override instead of falling back to the environment", () => {
    expect(() => resolveConfig(env, { model: " " })).toThrow("Set ZD_MODEL");
  });

  it.each(["localhost:1234", "not a URL", "/v1/chat/completions", "ftp://host/chat"])(
    "rejects invalid HTTP endpoints: %s", (url) => {
      expect(() => resolveConfig({ ...env, ZD_URL: url })).toThrow("complete HTTP(S)");
    },
  );
});
