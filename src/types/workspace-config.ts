/** Optional repository/group preparation, named services, and application URLs. */
export type WorkspaceConfig = {
  prepareCommand?: string;
  services?: Record<string, { startCommand: string; stopCommand?: string }>;
  frontUrl?: string; apiUrl?: string; dbUrl?: string;
};
