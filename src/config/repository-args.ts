/** Shared optional starting directory for repository discovery. */
export const REPOSITORY_ARGS = {
  path: {
    type: "positional",
    description: "Repository or parent directory to inspect; defaults to the current directory.",
    default: ".",
  },
} as const;
