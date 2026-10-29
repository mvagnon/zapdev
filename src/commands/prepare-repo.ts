import { defineCommand } from "citty";

import { prepareSelection } from "../lib/preparation";
import { validateRepository } from "../lib/repositories";
import { runWorkspaceTask, WORKSPACE_ARGS } from "./workspace-task";

/** Prepare one disposable checkout, confirming its destructive reset in a terminal. */
export const prepareRepoCommand = defineCommand({
  meta: { name: "prepare-repo", description: "Clone/reset a disposable GitHub checkout, link secrets and run preparation commands." },
  args: {
    ...WORKSPACE_ARGS,
    repo: { type: "positional", required: false, description: "GitHub owner/repo." },
    group: { type: "string", description: "Optional group folder inside ZD_REPOS_DIR." },
    branch: { type: "string", description: "Remote branch; defaults to the remote default branch." },
  },
  async run({ args }) {
    await runWorkspaceTask("prepare-repo", args, async (ui) => {
      const repo = await ui.input(args.repo, "GitHub repository (owner/repo)");
      const group = await ui.input(args.group, "Group (empty for a root checkout)", "");
      const branch = await ui.input(args.branch, "Remote branch (empty for the default branch)", "");
      const selection = validateRepository(repo, group);
      await ui.confirm(`Prepare ${selection.repo}? This discards tracked edits and untracked non-ignored files in its disposable checkout.`);
      return ui.task("Preparing repository", "Repository prepared", () => prepareSelection({ ...selection, branch: branch || undefined }));
    });
  },
});
