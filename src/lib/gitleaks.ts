import { x } from "tinyexec";

export async function hasGitleaks(): Promise<boolean> {
  try {
    await x("gitleaks", ["version"], { nodePath: false });
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Scan the given repository's staged changes before sending them to the LLM. */
export async function scanStagedChanges(repo: string): Promise<void> {
  const result = await x("gitleaks", ["git", "--staged", "--verbose"], {
    nodePath: false,
    nodeOptions: { cwd: repo },
  });
  if (result.exitCode === 0) return;

  const output = result.stderr.trim() || result.stdout.trim();
  throw new Error(output || "gitleaks git --staged failed");
}
