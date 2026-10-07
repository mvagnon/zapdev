import type { ChildProcess } from "node:child_process";

import type { GitOutputReporter } from "../types/git";

/** Forward decoded command output as it arrives, preserving partial lines. */
export function reportProcessOutput(child: ChildProcess | undefined, onOutput?: GitOutputReporter): void {
  if (!onOutput) return;
  for (const stream of ["stdout", "stderr"] as const) {
    child?.[stream]?.setEncoding("utf8").on("data", (chunk: string) => onOutput(chunk, stream));
  }
}
