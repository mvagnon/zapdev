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

export async function scanStagedChanges(): Promise<void> {
  const result = await x("gitleaks", ["git", "--staged"], { nodePath: false });
  if (result.exitCode === 0) return;

  const output = result.stderr.trim() || result.stdout.trim();
  throw new Error(output || "gitleaks git --staged failed");
}
