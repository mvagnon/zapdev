import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { prepareSelection } from "./preparation";
import { runProcess } from "./process";

vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: vi.fn() }));
vi.mock("./process", () => ({ runProcess: vi.fn() }));

let home: string;
let root: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "zapdev-preparation-")));
  root = join(home, ".zapdev", "repos");
  vi.mocked(homedir).mockReturnValue(home);
  vi.stubEnv("ZD_REPOS_DIR", root);
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => ({
    stdout: command === "git" && args[0] === "config" ? "https://github.com/owner/repo.git"
      : command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel" ? options!.cwd! : "",
    stderr: "",
  }));
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function addResources(identity: string, command: string): Promise<string> {
  const secrets = join(home, ".zapdev", "secrets", identity);
  const config = join(home, ".zapdev", "config", identity);
  await mkdir(secrets, { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(join(secrets, ".env"), command);
  await writeFile(join(config, "zapdev.json"), JSON.stringify({ prepareCommand: command }));
  return join(secrets, ".env");
}

it.each([true, false])("prepares group resources and only the selected repository's resources (own resources: %s)", async own => {
  const parent = join(root, "team");
  const checkout = join(parent, "owner__repo");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const groupSecret = await addResources("team", "prepare-group");
  const repoSecret = own ? await addResources("team/owner__repo", "prepare-repo") : undefined;
  await addResources("team/other__repo", "prepare-other");
  await writeFile(join(parent, ".env"), "old group secret");

  await expect(prepareSelection({ repo: "owner/repo", group: "team", branch: "main" })).resolves.toEqual({ path: checkout });

  expect(await readlink(join(parent, ".env"))).toBe(groupSecret);
  if (repoSecret) expect(await readlink(join(checkout, ".env"))).toBe(repoSecret);
  else await expect(readlink(join(checkout, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(vi.mocked(runProcess).mock.calls.filter(([command]) => command === "/bin/sh")).toEqual([
    ["/bin/sh", ["-c", "prepare-group"], { cwd: parent }],
    ...(own ? [["/bin/sh", ["-c", "prepare-repo"], { cwd: checkout }]] : []),
  ]);

  await prepareSelection({ repo: "owner/repo", group: "team", branch: "main" });
  expect(await readlink(join(parent, ".env"))).toBe(groupSecret);
});

it.each([true, false])("prepares an ungrouped repository without parent fallback (own resources: %s)", async own => {
  const checkout = join(root, "owner__repo");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await addResources("", "prepare-root");
  const repoSecret = own ? await addResources("owner__repo", "prepare-repo") : undefined;

  await prepareSelection({ repo: "owner/repo", branch: "main" });

  await expect(readlink(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  if (repoSecret) expect(await readlink(join(checkout, ".env"))).toBe(repoSecret);
  else await expect(readlink(join(checkout, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(vi.mocked(runProcess).mock.calls.filter(([command]) => command === "/bin/sh")).toEqual(
    own ? [["/bin/sh", ["-c", "prepare-repo"], { cwd: checkout }]] : [],
  );
});
