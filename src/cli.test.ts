import { settings, updateSettings } from "@clack/prompts";
import { runMain } from "citty";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("citty", async (importOriginal) => ({
  ...await importOriginal<typeof import("citty")>(),
  runMain: vi.fn(),
}));
vi.mock("./commands/commit", () => ({ commitCommand: { args: {} } }));

afterEach(() => { updateSettings({ withGuide: true }); });

it("enables the Clack guide globally before running any command", async () => {
  updateSettings({ withGuide: false });
  vi.mocked(runMain).mockImplementation(async () => {
    expect(settings.withGuide).toBe(true);
  });

  await import("./cli");
  expect(runMain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    subCommands: { commit: { args: {} } },
  }));
});
