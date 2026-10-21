/** Shared CLI overrides for the configured Chat Completions endpoint. */
export const LLM_ARGS = {
  url: {
    type: "string",
    description: "Override $ZD_URL, the complete Chat Completions endpoint.",
  },
  model: {
    type: "string",
    description: "Override the model configured with $ZD_MODEL.",
  },
  effort: {
    type: "string",
    description: "Override $ZD_EFFORT, sent as reasoning_effort.",
  },
} as const;
