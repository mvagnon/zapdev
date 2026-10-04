import { afterEach, expect, it, vi } from "vitest";

import { createHookReporter } from "./git-hooks";

afterEach(() => vi.useRealTimers());

it("reports only hook starts and their matching exits across Git subprocesses", () => {
  const onHook = vi.fn();
  const { report } = createHookReporter(onHook, vi.fn(), 60_000);
  const start = { event: "child_start", sid: "parent", child_id: 0, child_class: "hook", hook_name: "pre-commit" };
  const exit = { event: "child_exit", sid: "parent", child_id: 0, code: 0 };

  for (const line of ["not JSON", "null", "[]", '{"event":"child_start"}']) report(line);
  report(JSON.stringify(start));
  report(JSON.stringify({ ...exit, sid: "nested" }));
  report(JSON.stringify({ ...start, sid: "nested", hook_name: "reference-transaction" }));
  report(JSON.stringify({ ...exit, sid: "nested", code: 2 }));
  report(JSON.stringify(exit));
  report(JSON.stringify(exit));
  report(JSON.stringify({ ...start, child_id: 1, child_class: "editor", hook_name: undefined }));
  report(JSON.stringify({ ...exit, child_id: 1 }));

  expect(onHook.mock.calls.map(([event]) => event)).toEqual([
    { name: "pre-commit", phase: "start" },
    { name: "reference-transaction", phase: "start" },
    { name: "reference-transaction", phase: "exit", exitCode: 2 },
    { name: "pre-commit", phase: "exit", exitCode: 0 },
  ]);
});

it.each([60_000, 120_000])("enforces a per-hook deadline of %s ms, cancelling timers on exit and cleanup", (timeout) => {
  vi.useFakeTimers();
  const onTimeout = vi.fn();
  const { report, close } = createHookReporter(vi.fn(), onTimeout, timeout);
  const start = { event: "child_start", sid: "parent", child_id: 0, child_class: "hook", hook_name: "pre-commit" };
  report(JSON.stringify(start));
  vi.advanceTimersByTime(timeout - 1);
  expect(onTimeout).not.toHaveBeenCalled();
  report(JSON.stringify({ ...start, sid: "nested" }));
  report(JSON.stringify({ event: "child_exit", sid: "parent", child_id: 0, code: 0 }));
  vi.advanceTimersByTime(1);
  expect(onTimeout).not.toHaveBeenCalled();
  vi.advanceTimersByTime(timeout - 1);
  expect(onTimeout).toHaveBeenCalledExactlyOnceWith("pre-commit");

  report(JSON.stringify({ ...start, child_id: 1, hook_name: "commit-msg" }));
  close();
  vi.advanceTimersByTime(timeout);
  expect(onTimeout).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
