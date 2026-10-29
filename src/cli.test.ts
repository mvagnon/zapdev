import { cancel, log, note, select, settings, updateSettings } from "@clack/prompts";
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
  cancel: vi.fn(),
  select: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
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
  { args: ["commit"], interactive: true },
  { args: ["--help"], interactive: true },
  { args: ["--version"], interactive: false },
  { args: ["commit", "--type", "invalid"], interactive: true, error: new Error("Invalid commit type") },
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

it.each([
  ["commit"], ["pr"], ["prepare-repo"], ["prepare-worktree"],
  ["services", "list"], ["services", "start"], ["services", "stop"], ["services", "logs"],
])("dispatches only the selected command from the bare CLI menu (%j)", async (...path: string[]) => {
  process.argv = [argv[0]!, argv[1]!];
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  for (const choice of path) vi.mocked(select).mockResolvedValueOnce(choice);

  await import("./cli");

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { rawArgs: path });
  expect(runMain).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledTimes(path.length);
});

it.each([0, 1])("does not execute anything when the menu is cancelled at level %s", async (level) => {
  process.argv = [argv[0]!, argv[1]!];
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  if (level) vi.mocked(select).mockResolvedValueOnce("services");
  vi.mocked(select).mockResolvedValueOnce(Symbol("cancel"));

  await import("./cli");

  expect(runCommand).not.toHaveBeenCalled();
  expect(runMain).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([[false, false], [false, true], [true, false]])("shows help without running a command when the bare CLI has no terminal (%s, %s)", async (stdin, stdout) => {
  process.argv = [argv[0]!, argv[1]!];
  process.stdin.isTTY = stdin;
  process.stdout.isTTY = stdout;

  await import("./cli");

  expect(runMain).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { rawArgs: ["--help"] });
  expect(runCommand).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});
