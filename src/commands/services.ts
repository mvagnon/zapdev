import { resolve } from "node:path";

import { defineCommand } from "citty";

import { manageServices, selectServices } from "../lib/services";
import { runWorkspaceTask, WORKSPACE_ARGS, WORKSPACE_PATH } from "./workspace-task";

function serviceCommand(action: "list" | "start" | "stop" | "logs") {
  return defineCommand({
    meta: { name: action, description: `${action[0]!.toUpperCase()}${action.slice(1)} configured services${action === "start" || action === "stop" ? " using Linux/systemd" : ""}.` },
    args: {
      ...WORKSPACE_ARGS,
      path: WORKSPACE_PATH,
      service: { type: "string", description: "Service name; defaults to all configured services." },
      ...(action === "logs" ? { lines: { type: "string" as const, description: "Log lines per service (1–1000); defaults to 100." } } : {}),
    },
    async run({ args }) {
      await runWorkspaceTask(`services ${action}`, args, async (ui) => {
        const path = resolve(await ui.input(args.path, "Repository or group", process.cwd()));
        const service = await ui.input(args.service, "Service (empty for all)", "");
        const lines = action === "logs" ? Number(await ui.input(args.lines, "Log lines per service", "100")) : 100;
        if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error("Expected --lines between 1 and 1000.");
        const selection = await selectServices({ path, service: service || undefined });
        if ((action === "start" || action === "stop") && selection.services.length) {
          await ui.confirm(`${action === "start" ? "Start" : "Stop"} ${selection.services.map(({ name, path }) => `${name} (${path})`).join(", ")}?`);
        }
        return ui.task(`Running services ${action}`, `Services ${action} finished`, () => manageServices(selection, action, lines));
      });
    },
  });
}

/** Discover, supervise and inspect configured services; listing is the default operation. */
export const servicesCommand = defineCommand({
  meta: { name: "services", description: "Discover and manage configured repository/group services." },
  subCommands: { list: serviceCommand("list"), start: serviceCommand("start"), stop: serviceCommand("stop"), logs: serviceCommand("logs") },
  default: "list",
});
