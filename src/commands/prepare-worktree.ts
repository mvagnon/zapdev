import { resolve } from "node:path";

import { defineCommand } from "citty";

import { prepareWorktree } from "../lib/prepare-worktree";
import { runWorkspaceTask, WORKSPACE_ARGS, WORKSPACE_PATH } from "./workspace-task";

/** Create isolated worktrees from the selected source HEADs and prepare their resources. */
export const prepareWorktreeCommand = defineCommand({
  meta: { name: "prepare-worktree", description: "Create a new branch and prepared worktrees without resetting source checkouts." },
  args: {
    ...WORKSPACE_ARGS,
    path: WORKSPACE_PATH,
    branch: { type: "string", description: "Required new local branch, shared by every selected repository." },
  },
  async run({ args }) {
    await runWorkspaceTask("prepare-worktree", args, async (ui) => {
      const path = resolve(await ui.input(args.path, "Source repository or group", process.cwd()));
      const branch = await ui.input(args.branch, "New branch");
      await ui.confirm(`Create ${branch} worktrees from ${path}?`);
      return ui.task("Preparing worktrees", "Worktree preparation finished", () => prepareWorktree({ path, branch }));
    });
  },
});
