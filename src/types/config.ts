/** Explicit configuration for an OpenAI-compatible Chat Completions endpoint. */
export type ZapdevConfig = {
  url: string;
  model: string;
  effort: string;
};

/** Repository-relative subtree folders mapped to their Git remote names. */
export type SubtreeMapping = Record<string, string>;
