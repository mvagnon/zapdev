import { updateSettings } from "@clack/prompts";
import { defineCommand, runCommand, runMain } from "citty";

import pkg from "../package.json";
import { commitCommand } from "./commands/commit";
import { prCommand } from "./commands/pr";
import { prepareRepoCommand } from "./commands/prepare-repo";
import { prepareWorktreeCommand } from "./commands/prepare-worktree";
import { reportError } from "./commands/report-error";
import { servicesCommand } from "./commands/services";

updateSettings({ withGuide: true });

const main = defineCommand({
  meta: {
    name: "zapdev",
    version: pkg.version,
    description: "Fast, precise git chores from your terminal.",
  },
  args: commitCommand.args,
  subCommands: { commit: commitCommand, pr: prCommand, "prepare-repo": prepareRepoCommand, "prepare-worktree": prepareWorktreeCommand, services: servicesCommand },
  default: "commit",
});

const rawArgs = process.argv.slice(2);
try {
  if (rawArgs.some((arg) => arg === "--help" || arg === "-h")
    || (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v"))) {
    await runMain(main);
  } else {
    await runCommand(main, { rawArgs });
  }
} catch (error) {
  reportError(error);
}
