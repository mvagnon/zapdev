/** Shared automation flags; legacy confirmation flags remain compatible. */
export const INTERACTION_ARGS = {
  "non-interactive": {
    type: "boolean",
    description: "Skip all questions and use defaults; explicit values still apply.",
  },
  // deprecated on 2026-10-29: --non-interactive; retain --yes/-y for existing scripts and clients.
  yes: {
    type: "boolean",
    alias: "y",
    description: "Deprecated: use --non-interactive. Skip default confirmations.",
  },
} as const;
