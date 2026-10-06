/** A Git hook invocation observed through Trace2. */
export type HookEvent =
  | { name: string; phase: "start" }
  | { name: string; phase: "exit"; exitCode: number };

/** Receive hook progress without changing how Git executes the hook. */
export type HookReporter = (event: HookEvent) => void;

/** Mark the boundaries of terminal-inherited Git output without styling it in the Git runner. */
export type NativeOutputReporter = (phase: "start" | "exit") => void;
