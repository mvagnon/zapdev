import { selectRepositories } from "./repositories";
import { runSystemdService } from "./systemd";
import { resolveConfigs, validateServiceName } from "./workspace-config";
import type { Service, ServiceOutput, ServiceSummary } from "../types/service";

/** Select configured services without executing commands or querying systemd. */
export async function selectServices(input: { path?: string; service?: string }): Promise<{ path: string; services: Service[] }> {
  validateServiceName(input.service);
  const selection = await selectRepositories(input.path);
  const services = resolveConfigs(selection).flatMap(({ path, value }) =>
    Object.entries(value.services ?? {}).map(([name, config]) => ({ name, path, ...config })));
  const filtered = input.service === undefined ? services : services.filter(({ name }) => name === input.service);
  if (input.service !== undefined && filtered.length === 0) throw new Error(`Unknown service: ${input.service}`);
  return { path: selection.path, services: filtered };
}

/** Return compact lifecycle summaries or full bounded diagnostics, preserving each service's failure. */
export async function manageServices(selection: { path: string; services: Service[] }, action: "list" | "start" | "stop" | "logs", lines = 100): Promise<ServiceOutput> {
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error("Expected --lines between 1 and 1000.");
  if (action === "list") return { path: selection.path, services: selection.services.map(({ name, path }) => ({ name, path })) };
  if (action === "logs") return { path: selection.path, services: await Promise.all(selection.services.map(service => runSystemdService(service, action, lines))) };
  const services: ServiceSummary[] = [];
  for (const service of selection.services) {
    const { name, path, id, state, mainPid, error, maxRuntimeSeconds } = await runSystemdService(service, action, lines);
    services.push({
      name, path, ...(state !== undefined && { state }), ...(error !== undefined && { error }),
      ...(action === "start" && error !== undefined && { id, ...(mainPid !== undefined && { mainPid }) }),
      ...(action === "start" && maxRuntimeSeconds !== undefined && { maxRuntimeSeconds }),
    });
  }
  return { path: selection.path, services };
}
