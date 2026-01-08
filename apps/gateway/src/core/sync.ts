import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { registryPath, readRegistryFile, writeRegistryFile, type Registry } from "../infra/registry/registry.js";
import { sourceRegistryPath } from "../shared/source.js";

import { syncCommandsFromSource, type CommandSyncResult } from "./commands/sync.js";
import { syncSkillsFromSource, type SkillSyncOptions, type SkillSyncResult } from "./skills/sync.js";

type RegistrySyncOptions = {
  sourcePath?: string;
  backup?: boolean;
  dryRun?: boolean;
};

type RegistrySyncResult = {
  ok: boolean;
  sourcePath: string;
  destPath: string;
  dryRun: boolean;
  backupPath?: string;
  registry?: Registry;
  error?: string;
};

function backupPath(original: string): string {
  return `${original}.bak.${Math.floor(Date.now() / 1000)}`;
}

async function syncRegistryFromSource(options: RegistrySyncOptions = {}): Promise<RegistrySyncResult> {
  const sourcePath = options.sourcePath ?? sourceRegistryPath();
  const destPath = registryPath();
  const result: RegistrySyncResult = { ok: true, sourcePath, destPath, dryRun: options.dryRun === true };

  if (!existsSync(sourcePath)) {
    return { ...result, ok: false, error: `source registry not found: ${sourcePath}` };
  }

  const registry = await readRegistryFile(sourcePath);
  result.registry = registry;

  if (result.dryRun) {
    return result;
  }

  if (options.backup && existsSync(destPath)) {
    const backup = backupPath(destPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(destPath, backup);
    result.backupPath = backup;
  }

  await writeRegistryFile(destPath, registry);
  return result;
}

type SyncOptions = {
  sourceDir?: string;
  syncRegistry?: boolean;
  syncSkills?: boolean;
  syncCommands?: boolean;
  backup?: boolean;
  dryRun?: boolean;
  skillTarget?: SkillSyncOptions["target"];
  pruneSkills?: boolean;
  commandTarget?: "codex" | "claude" | "both";
  commandScope?: "global" | "project" | "both";
  repoDir?: string;
  pruneCommands?: boolean;
};

type SyncResult = {
  ok: boolean;
  registry?: RegistrySyncResult;
  skills?: SkillSyncResult;
  commands?: CommandSyncResult;
  errors: string[];
};

export async function syncFromSource(options: SyncOptions = {}): Promise<SyncResult> {
  const errors: string[] = [];
  const result: SyncResult = { ok: true, errors };
  const syncRegistry = options.syncRegistry !== false;
  const syncSkills = options.syncSkills !== false;
  const syncCommands = options.syncCommands !== false;
  const sourceRoot = options.sourceDir;

  if (syncRegistry) {
    const registry = await syncRegistryFromSource({
      sourcePath: sourceRoot ? path.join(sourceRoot, "registry.json") : undefined,
      backup: options.backup,
      dryRun: options.dryRun,
    });
    result.registry = registry;
    if (!registry.ok) errors.push(registry.error || "registry sync failed");
  }

  if (syncSkills) {
    const skills = await syncSkillsFromSource({
      sourceDir: sourceRoot ? path.join(sourceRoot, "skills") : undefined,
      target: options.skillTarget,
      dryRun: options.dryRun,
      prune: options.pruneSkills,
    });
    result.skills = skills;
    if (!skills.ok) errors.push(...skills.errors);
  }

  if (syncCommands) {
    const commands = await syncCommandsFromSource({
      sourceDir: sourceRoot ? path.join(sourceRoot, "commands") : undefined,
      target: options.commandTarget,
      scope: options.commandScope,
      repoDir: options.repoDir,
      dryRun: options.dryRun,
      prune: options.pruneCommands,
    });
    result.commands = commands;
    if (!commands.ok) errors.push(...commands.errors);
  }

  result.ok = errors.length === 0;
  return result;
}
