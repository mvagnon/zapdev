/** One checkout and its original configuration identity. */
export type Repository = { path: string; source: string };

/** A selected repository or group and its source configuration scope. */
export type RepositorySelection = {
  path: string; source: string | undefined; root: string; isRepository: boolean; repositories: Repository[];
};
