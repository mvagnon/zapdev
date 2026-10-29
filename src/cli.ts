import { cancel, isCancel, select, updateSettings } from "@clack/prompts";
import { defineCommand, runCommand, runMain } from "citty";

import pkg from "../package.json";
import { commitCommand } from "./commands/commit";
import { prCommand } from "./commands/pr";
import { prepareRepoCommand } from "./commands/prepare-repo";
import { prepareWorktreeCommand } from "./commands/prepare-worktree";
import { reportError } from "./commands/report-error";
import { servicesCommand } from "./commands/services";
import { updateRepoCommand } from "./commands/update-repo";

updateSettings({ withGuide: true });

const main = defineCommand({
  meta: {
    name: "zapdev",
    version: pkg.version,
    description: "Fast, precise git chores from your terminal.",
  },
  args: commitCommand.args,
  subCommands: { commit: commitCommand, pr: prCommand, "prepare-repo": prepareRepoCommand, "update-repo": updateRepoCommand, "prepare-worktree": prepareWorktreeCommand, services: servicesCommand },
  default: "commit",
});

async function chooseCommand(): Promise<string[] | undefined> {
  const path: string[] = [];
  let available = main.subCommands;
  while (available) {
    const commands = await (typeof available === "function" ? available() : available);
    if (!commands || Object.keys(commands).length === 0) break;
    const choice = await select({
      message: path.length ? `${path.join(" ")} command` : "Command",
      options: Object.keys(commands).map(value => ({ value, label: value })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return;
    }
    path.push(choice);
    const command = commands[choice]!;
    const selected = await (typeof command === "function" ? command() : command);
    available = selected.subCommands;
  }
  return path;
}

const rawArgs = process.argv.slice(2);
try {
  if (rawArgs.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const command = await chooseCommand();
      if (command) await runCommand(main, { rawArgs: command });
    } else {
      await runMain(main, { rawArgs: ["--help"] });
    }
  } else if (rawArgs.some((arg) => arg === "--help" || arg === "-h")
    || (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v"))) {
    await runMain(main);
  } else {
    await runCommand(main, { rawArgs });
  }
} catch (error) {
  reportError(error);
}
