import type { HookReporter } from "../types/git";

/** Match Trace2 hook events and enforce the configured deadline per invocation. */
export function createHookReporter(onHook: HookReporter | undefined, onTimeout: (name: string) => void, timeout: number): {
  report: (line: string) => void;
  close: () => void;
} {
  const hooks = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
  const report = (line: string): void => {
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
      const name = event.hook_name;
      hooks.set(key, { name, timer: setTimeout(() => onTimeout(name), timeout) });
      onHook?.({ name, phase: "start" });
    } else if (event.event === "child_exit" && typeof event.code === "number") {
      const hook = hooks.get(key);
      if (!hook) return;
      clearTimeout(hook.timer);
      hooks.delete(key);
      onHook?.({ name: hook.name, phase: "exit", exitCode: event.code });
    }
  };
  return {
    report,
    close() {
      for (const { timer } of hooks.values()) clearTimeout(timer);
      hooks.clear();
    },
  };
}
