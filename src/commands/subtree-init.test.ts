import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/subtree-init", () => ({ initializeSubtrees: vi.fn(), parseSubtreeSources: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(), outro: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "@clack/prompts";
import { GitOutputError } from "../lib/errors";
import { initializeSubtrees, parseSubtreeSources } from "../lib/subtree-init";
import { subtreeInitCommand } from "./subtree-init";

const sources = [{ name: "front", url: "front-url" }, { name: "back", url: "back-url" }];
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  vi.mocked(parseSubtreeSources).mockReturnValue(sources);
});

afterEach(() => { process.exitCode = exitCode; });

it("parses multiple sources and --origin independently of option order", async () => {
  await runCommand(subtreeInitCommand, { rawArgs: ["project", "front=front-url", "--origin", "parent-url", "back=back-url"] });

  expect(parseSubtreeSources).toHaveBeenCalledExactlyOnceWith(["front=front-url", "back=back-url"]);
  expect(initializeSubtrees).toHaveBeenCalledExactlyOnceWith("project", sources, {
    origin: "parent-url", onProgress: log.info, onWarning: log.warn,
  });
});

it("rejects invalid sources before creating a repository", async () => {
  vi.mocked(parseSubtreeSources).mockImplementation(() => { throw new Error("Invalid source"); });

  await runCommand(subtreeInitCommand, { rawArgs: ["project", "invalid"] });

  expect(initializeSubtrees).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("Invalid source");
  expect(process.exitCode).toBe(1);
});

it("requires a directory and at least one source", async () => {
  await expect(runCommand(subtreeInitCommand, { rawArgs: [] })).rejects.toThrow("Missing required positional");
  await expect(runCommand(subtreeInitCommand, { rawArgs: ["project"] })).rejects.toThrow("Missing required positional");
  expect(initializeSubtrees).not.toHaveBeenCalled();
});

it("does not repeat native Git diagnostics", async () => {
  vi.mocked(initializeSubtrees).mockRejectedValue(new GitOutputError("Native Git diagnostic"));

  await runCommand(subtreeInitCommand, { rawArgs: ["project", "front=front-url"] });

  expect(log.error).toHaveBeenCalledExactlyOnceWith("Subtree initialization failed.");
  expect(process.exitCode).toBe(1);
});
