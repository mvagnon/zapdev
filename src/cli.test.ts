import { settings, updateSettings } from "@clack/prompts";
import { runMain } from "citty";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("citty", async (importOriginal) => ({
  ...await importOriginal<typeof import("citty")>(),
  runMain: vi.fn(),
}));
vi.mock("./commands/commit", () => ({ commitCommand: { args: {} } }));
vi.mock("./commands/subtree-init", () => ({ subtreeInitCommand: {} }));

afterEach(() => { updateSettings({ withGuide: true }); });

it("disables the Clack guide globally before running any command", async () => {
  updateSettings({ withGuide: true });
  vi.mocked(runMain).mockImplementation(async () => {
    expect(settings.withGuide).toBe(false);
  });

  await import("./cli");
  expect(runMain).toHaveBeenCalledExactlyOnceWith(expect.any(Object));
});
