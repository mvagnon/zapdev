import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";

const env = { ZD_URL: "http://localhost:1234/v1/chat/completions", ZD_MODEL: "my-model", ZD_EFFORT: "low" };

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
