import { intro, log, outro } from "@clack/prompts";
import { defineCommand } from "citty";

import { errorMessage, GitOutputError } from "../lib/errors";
import { initializeSubtrees, parseSubtreeSources } from "../lib/subtree-init";

/** Initialize named subtrees and their zapdev.json mapping without an LLM or external prompt tool. */
export const subtreeInitCommand = defineCommand({
  meta: { name: "subtree-init", description: "Initialize a repository with squashed subtrees and their named remotes." },
  args: {
    directory: { type: "positional", required: true, description: "Repository directory to create or extend." },
    subtree: { type: "positional", required: true, description: "name=url; add more positional sources for additional subtrees." },
    origin: { type: "string", description: "Optional URL for the parent repository's origin remote." },
  },
  async run({ args }) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    try {
      const sources = parseSubtreeSources(args._.slice(1));
      if (interactive) intro("zapdev subtree-init");
      await initializeSubtrees(args.directory, sources, {
        origin: args.origin, onProgress: log.info, onWarning: log.warn,
      });
      if (interactive) outro("Subtrees ready.");
      else log.info("Subtrees ready.");
    } catch (error) {
      log.error(error instanceof GitOutputError ? "Subtree initialization failed." : errorMessage(error));
      process.exitCode = 1;
    }
  },
});
