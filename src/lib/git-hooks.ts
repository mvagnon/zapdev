import type { HookReporter } from "../types/git";

/** Match Trace2 hook starts and exits, including nested Git processes. */
export function createHookReporter(onHook: HookReporter): (line: string) => void {
  const hooks = new Map<string, string>();
  return (line) => {
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      event = value as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.sid !== "string" || typeof event.child_id !== "number") return;
    const key = `${event.sid}:${event.child_id}`;
    if (event.event === "child_start" && event.child_class === "hook" && typeof event.hook_name === "string") {
      hooks.set(key, event.hook_name);
      onHook({ name: event.hook_name, phase: "start" });
    } else if (event.event === "child_exit" && typeof event.code === "number") {
      const name = hooks.get(key);
      if (name === undefined) return;
      hooks.delete(key);
      onHook({ name, phase: "exit", exitCode: event.code });
    }
  };
}
