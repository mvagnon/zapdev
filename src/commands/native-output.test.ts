import { expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { message: vi.fn() }, S_BAR_END: "└", S_BAR_START: "┌",
}));

import { log } from "@clack/prompts";
import { reportNativeOutput } from "./native-output";

it("closes and resumes the guide with a clean line after native output", () => {
  reportNativeOutput("start");
  reportNativeOutput("exit");
  expect(vi.mocked(log.message).mock.calls).toEqual([
    ["└", { withGuide: false, spacing: 0 }],
    [["", "┌"], { withGuide: false, spacing: 0 }],
  ]);
});
