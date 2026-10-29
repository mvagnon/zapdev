import { x } from "tinyexec";

/** Run a bounded process without a shell, preserving command diagnostics on failure. */
export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number;
} = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await x(command, args, {
    nodePath: false,
    timeout: options.timeout ?? 180_000,
    nodeOptions: { cwd: options.cwd, env: options.env ?? process.env },
  });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`), {
      stdout: result.stdout, stderr: result.stderr, code: result.exitCode,
    });
  }
  return result;
}
