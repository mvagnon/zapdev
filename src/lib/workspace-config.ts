import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { repositoryRelativePath, worktreeRoot } from "./repositories";
import type { RepositorySelection } from "../types/repository";
import type { WorkspaceConfig } from "../types/workspace-config";

const serviceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Validate an optional named-service selector. */
export function validateServiceName(value: string | undefined): string | undefined {
  if (value !== undefined && !serviceName.test(value)) throw new Error("Expected a valid service name.");
  return value;
}

function resourceDirectory(root: string, source: string | undefined, kind: "config" | "secrets"): string | undefined {
  const identity = source === undefined ? undefined : repositoryRelativePath(root, source);
  if (identity === undefined) return undefined;
  let directory = homedir();
  for (const part of [".zapdev", kind, ...identity.split(sep).filter(Boolean)]) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isDirectory()) throw new Error(`Expected an existing directory, not a symlink: ${directory}`);
  }
  return directory;
}

/** Resolve resources exclusively at the selected scope, falling back once to parent or immediate repositories. */
export function resolveResources<T>(
  selection: RepositorySelection, kind: "config" | "secrets", read: (directory: string, recursive: boolean) => T | undefined,
): { path: string; value: T }[] {
  const { root, path, source, isRepository, repositories } = selection;
  const at = (target: { path: string; source: string | undefined }, recursive: boolean): { path: string; value: T }[] => {
    const directory = resourceDirectory(root, target.source, kind);
    const value = directory === undefined ? undefined : read(directory, recursive);
    return value === undefined ? [] : [{ path: target.path, value }];
  };
  const own = at(selection, isRepository);
  if (own.length > 0) return own;
  const fallback = isRepository
    ? at({ path: dirname(path), source: source === undefined ? undefined : dirname(source) }, false)
    : repositories.flatMap(repository => at(repository, true));
  if (isRepository && path !== source && fallback.some(target => target.path === worktreeRoot())) {
    throw new Error(`Parent resources require an isolated workspace; prepare a new worktree instead: ${path}`);
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function command(value: unknown, rejectNull: boolean): value is string {
  return typeof value === "string" && value.trim().length > 0 && (!rejectNull || !value.includes("\0"));
}

function parseConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value) || Object.keys(value).some(key => !["prepareCommand", "services", "frontUrl", "apiUrl", "dbUrl"].includes(key))) throw new Error("Invalid config.");
  const config: WorkspaceConfig = {};
  if (value.prepareCommand !== undefined) {
    if (!command(value.prepareCommand, false)) throw new Error("Invalid preparation command.");
    config.prepareCommand = value.prepareCommand.trim();
  }
  if (value.services !== undefined) {
    if (!isRecord(value.services)) throw new Error("Invalid services.");
    config.services = {};
    for (const [name, service] of Object.entries(value.services)) {
      if (!serviceName.test(name) || !isRecord(service) || Object.keys(service).some(key => !["startCommand", "stopCommand"].includes(key)) ||
        !command(service.startCommand, true) || (service.stopCommand !== undefined && !command(service.stopCommand, true))) throw new Error("Invalid service.");
      Object.defineProperty(config.services, name, { enumerable: true, configurable: true, writable: true, value: {
        startCommand: service.startCommand.trim(), ...(typeof service.stopCommand === "string" && { stopCommand: service.stopCommand.trim() }),
      } });
    }
  }
  for (const key of ["frontUrl", "apiUrl", "dbUrl"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw new Error("Invalid URL.");
      new URL(value[key]);
      config[key] = value[key];
    }
  }
  return config;
}

function readConfig(directory: string): WorkspaceConfig | undefined {
  const file = join(directory, "zapdev.json");
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error(`Expected a regular config file, not a symlink: ${file}`);
  try {
    return parseConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`Invalid configuration in ${file}: expected prepareCommand, named services with startCommand and optional stopCommand, and valid URLs.`);
  }
}

/** Resolve repository/group configuration independently from secrets. */
export function resolveConfigs(selection: RepositorySelection): { path: string; value: WorkspaceConfig }[] {
  return resolveResources(selection, "config", readConfig);
}
