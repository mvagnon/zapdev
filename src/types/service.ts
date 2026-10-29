/** One named service configured in its repository or group directory. */
export type Service = { name: string; path: string; startCommand: string; stopCommand?: string };
/** Supported service lifecycle and diagnostic operations. */
export type ServiceAction = "start" | "stop" | "logs";
/** Observed service state, shutdown policy, and optional bounded diagnostics. */
export type ServiceResult = {
  name: string; path: string; id: string; state?: string; subState?: string;
  result?: string; exitCode?: number; exists?: boolean; logs?: string; truncated?: boolean; error?: string;
  mainPid?: number; controlPid?: number; tasks?: number; controlGroup?: string; maxRuntimeSeconds?: number;
};
/** Compact results for discovery and lifecycle actions, full diagnostics for logs. */
export type ServiceSummary = Pick<ServiceResult, "name" | "path" | "state" | "error" | "maxRuntimeSeconds"> & Partial<Pick<ServiceResult, "id" | "mainPid">>;
/** Services selected from one repository or group. */
export type ServiceOutput = { path: string; services: ServiceSummary[] | ServiceResult[] };
