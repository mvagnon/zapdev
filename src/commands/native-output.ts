import { styleText } from "node:util";
import { log, S_BAR_END, S_BAR_START } from "@clack/prompts";

import type { NativeOutputReporter } from "../types/git";

/** Close and resume the Clack guide around terminal-inherited Git output. */
export const reportNativeOutput: NativeOutputReporter = (phase) => {
  const symbol = styleText("gray", phase === "start" ? S_BAR_END : S_BAR_START);
  log.message(phase === "start" ? symbol : ["", symbol], { withGuide: false, spacing: 0 });
};
