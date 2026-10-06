import { defineCommand, runMain } from "citty";

import pkg from "../package.json";
import { commitCommand } from "./commands/commit";
import { subtreeInitCommand } from "./commands/subtree-init";

const main = defineCommand({
  meta: {
    name: "zapdev",
    version: pkg.version,
    description: "Fast, precise git chores from your terminal.",
  },
  args: commitCommand.args,
  subCommands: { commit: commitCommand, "subtree-init": subtreeInitCommand },
  default: "commit",
});

await runMain(main);
