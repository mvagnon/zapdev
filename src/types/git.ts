/** Line counts in a staged diff, excluding binary files. */
export type DiffStats = { additions: number; deletions: number };

/** A Git hook invocation observed through Trace2. */
export type HookEvent =
  | { name: string; phase: "start" }
  | { name: string; phase: "exit"; exitCode: number };

/** Receive hook progress without changing how Git executes the hook. */
export type HookReporter = (event: HookEvent) => void;
