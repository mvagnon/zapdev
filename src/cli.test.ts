import { log, note, settings, updateSettings } from "@clack/prompts";
import { runCommand, runMain } from "citty";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("citty", async (importOriginal) => ({
  ...await importOriginal<typeof import("citty")>(),
  runMain: vi.fn(),
  runCommand: vi.fn(),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  log: { error: vi.fn() },
  note: vi.fn(),
}));
vi.mock("./commands/commit", () => ({ commitCommand: { args: {} } }));
vi.mock("./commands/pr", () => ({ prCommand: { args: {} } }));

const argv = process.argv;
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
const exitCode = process.exitCode;

afterEach(() => {
  updateSettings({ withGuide: true });
  process.argv = argv;
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  process.exitCode = exitCode;
  vi.resetAllMocks();
  vi.resetModules();
});

it.each([
  { args: [], interactive: true },
  { args: ["--help"], interactive: true },
  { args: ["--version"], interactive: false },
  { args: ["--type", "invalid"], interactive: true, error: new Error("Invalid commit type") },
  { args: ["unknown"], interactive: false, error: new Error("Unknown command") },
])("enables the guide and handles CLI failures ($args, TTY=$interactive)", async ({ args, interactive, error }) => {
  process.argv = [argv[0]!, argv[1]!, ...args];
  process.stdin.isTTY = interactive;
  process.stdout.isTTY = interactive;
  process.exitCode = undefined;
  updateSettings({ withGuide: false });
  vi.mocked(runMain).mockImplementation(async () => {
    expect(settings.withGuide).toBe(true);
  });
  vi.mocked(runCommand).mockImplementation(async () => {
    expect(settings.withGuide).toBe(true);
    if (error) throw error;
    return { result: undefined };
  });

  await import("./cli");
  const command = expect.objectContaining({
    subCommands: expect.objectContaining({ commit: { args: {} }, pr: { args: {} } }),
  });
  if (args.includes("--help") || args.includes("--version")) {
    expect(runMain).toHaveBeenCalledExactlyOnceWith(command);
    expect(runCommand).not.toHaveBeenCalled();
  } else {
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(command, { rawArgs: args });
    expect(runMain).not.toHaveBeenCalled();
  }
  if (error) {
    if (interactive) {
      expect(log.error).toHaveBeenCalledExactlyOnceWith("zapdev failed.", { spacing: 0 });
      expect(note).toHaveBeenCalledExactlyOnceWith(error.message, "Error details");
    } else {
      expect(log.error).toHaveBeenCalledExactlyOnceWith(error.message, { spacing: 0, withGuide: false });
      expect(note).not.toHaveBeenCalled();
    }
    expect(process.exitCode).toBe(1);
  } else {
    expect(log.error).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  }
});
