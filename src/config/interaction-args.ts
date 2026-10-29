/** Shared options for skipping default confirmations or all interactive questions. */
export const INTERACTION_ARGS = {
  "non-interactive": {
    type: "boolean",
    description: "Skip all questions and use defaults; explicit values still apply.",
  },
  yes: {
    type: "boolean",
    alias: "y",
    description: "Skip default confirmations while honoring explicitly requested questions.",
  },
} as const;
