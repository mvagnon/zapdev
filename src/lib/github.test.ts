import { afterEach, expect, it, vi } from "vitest";
import { x } from "tinyexec";

vi.mock("./git");
vi.mock("tinyexec", () => ({ x: vi.fn(async () => ({ exitCode: 0, stdout: "main\n", stderr: "" })) }));

import { currentBranch, getBranchCommits, getPushRemote, git } from "./git";
import { getPrContext } from "./github";

afterEach(() => vi.clearAllMocks());

it.each([undefined, "release/next"])("reads commits against the target branch (%s), defaulting only when omitted", async (target) => {
  vi.mocked(currentBranch).mockResolvedValue("feature/pr");
  vi.mocked(getPushRemote).mockResolvedValue("origin");
  vi.mocked(getBranchCommits).mockResolvedValue(["feat: search"]);
  vi.mocked(git).mockImplementation(async (args) => {
    if (args[0] === "remote") return "git@github.com:owner/repo.git\n";
    if (args[0] === "rev-parse") return args[1] === "FETCH_HEAD" ? "base-sha\n" : "head-sha\n";
    return "";
  });

  const context = await getPrContext("/repo", target);

  expect(context.base).toBe(target ?? "main");
  expect(git).toHaveBeenCalledWith([
    "fetch", "--no-tags", "--", "git@github.com:owner/repo.git", `refs/heads/${target ?? "main"}`,
  ], "/repo");
  expect(getBranchCommits).toHaveBeenCalledWith("/repo", "base-sha");
  expect(x).toHaveBeenCalledTimes(target === undefined ? 1 : 0);
});
