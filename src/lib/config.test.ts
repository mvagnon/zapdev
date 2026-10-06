import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveConfig, resolveHookTimeout, resolvePublishSubtree } from "./config";

const env = { ZD_URL: "http://localhost:1234/v1/chat/completions", ZD_MODEL: "my-model", ZD_EFFORT: "low" };

describe("resolvePublishSubtree", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "zapdev-config-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("defaults to classic push and only reads zapdev.json in the launch directory", async () => {
    await expect(resolvePublishSubtree(directory)).resolves.toBe(false);
    await writeFile(join(directory, "zapdev.json"), '{"isSubtree":true}');
    await expect(resolvePublishSubtree(directory)).resolves.toBe(true);
    const child = join(directory, "child");
    await mkdir(child);
    await expect(resolvePublishSubtree(child)).resolves.toBe(false);
  });

  it.each([true, false])("gives an explicit flag (%s) priority over the file", async (override) => {
    await writeFile(join(directory, "zapdev.json"), JSON.stringify({ isSubtree: !override }));
    await expect(resolvePublishSubtree(directory, override)).resolves.toBe(override);
  });

  it.each([{}, { isSubtree: false }])("accepts optional or false isSubtree: %j", async (config) => {
    await writeFile(join(directory, "zapdev.json"), JSON.stringify(config));
    await expect(resolvePublishSubtree(directory)).resolves.toBe(false);
  });

  it.each(['{', 'null', '[]', '{"isSubtree":"true"}', '{"isSubtree":1}', '{"isSubtree":null}'])(
    "rejects invalid configuration before choosing a push mode: %s", async (content) => {
      await writeFile(join(directory, "zapdev.json"), content);
      await expect(resolvePublishSubtree(directory)).rejects.toThrow("zapdev.json");
    });

  it("does not treat unreadable configuration as a missing file", async () => {
    await mkdir(join(directory, "zapdev.json"));
    await expect(resolvePublishSubtree(directory)).rejects.toThrow("Unable to read zapdev.json");
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
