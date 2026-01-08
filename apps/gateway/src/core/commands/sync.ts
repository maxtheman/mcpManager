import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { sourceCommandsDir } from "../../shared/source.js";

import {
  claudeGlobalCommandsDir,
  claudeProjectCommandsDir,
  codexPromptsDir,
  type CommandScope,
  type CommandTarget,
} from "./paths.js";

type CommandSyncOptions = {
  sourceDir?: string;
  target?: CommandTarget;
  scope?: CommandScope;
  repoDir?: string;
  dryRun?: boolean;
  prune?: boolean;
};

export type CommandSyncResult = {
  ok: boolean;
  sourceDir: string;
  dryRun: boolean;
  targets: Array<{
    target: "codex" | "claude";
    scope: "global" | "project";
    destDir: string;
    copiedFiles: number;
    copiedDirs: number;
    skipped: number;
    pruned: number;
  }>;
  errors: string[];
};

function isHidden(entry: string): boolean {
  return entry.startsWith(".");
}

async function copyDir(src: string, dest: string, dryRun: boolean): Promise<{ files: number; dirs: number; skipped: number }> {
  if (!existsSync(src)) return { files: 0, dirs: 0, skipped: 0 };
  const entries = await fs.readdir(src, { withFileTypes: true });
  let files = 0;
  let dirs = 0;
  let skipped = 0;
  if (!dryRun) {
    await fs.mkdir(dest, { recursive: true });
  }

  for (const entry of entries) {
    if (isHidden(entry.name)) {
      skipped += 1;
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const stat = await fs.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      skipped += 1;
      continue;
    }
    if (stat.isDirectory()) {
      dirs += 1;
      const nested = await copyDir(srcPath, destPath, dryRun);
      files += nested.files;
      dirs += nested.dirs;
      skipped += nested.skipped;
      continue;
    }
    if (stat.isFile()) {
      files += 1;
      if (!dryRun) {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(srcPath, destPath);
      }
      continue;
    }
    skipped += 1;
  }

  return { files, dirs, skipped };
}

async function listTopLevelDirs(root: string): Promise<Set<string>> {
  if (!existsSync(root)) return new Set();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && !isHidden(entry.name)) dirs.add(entry.name);
  }
  return dirs;
}

async function pruneDirs(srcRoot: string, destRoot: string, dryRun: boolean): Promise<number> {
  if (!existsSync(destRoot)) return 0;
  const srcDirs = await listTopLevelDirs(srcRoot);
  const destDirs = await listTopLevelDirs(destRoot);
  let removed = 0;
  for (const dir of destDirs) {
    if (srcDirs.has(dir)) continue;
    removed += 1;
    if (!dryRun) {
      await fs.rm(path.join(destRoot, dir), { recursive: true, force: true });
    }
  }
  return removed;
}

function resolveTargets(target: CommandTarget | undefined): Array<"codex" | "claude"> {
  if (!target || target === "both") return ["codex", "claude"];
  return [target];
}

function resolveScopes(scope: CommandScope | undefined): Array<"global" | "project"> {
  if (!scope || scope === "both") return ["global", "project"];
  return [scope];
}

export async function syncCommandsFromSource(options: CommandSyncOptions = {}): Promise<CommandSyncResult> {
  const sourceDir = options.sourceDir ?? sourceCommandsDir();
  const result: CommandSyncResult = {
    ok: true,
    sourceDir,
    dryRun: options.dryRun === true,
    targets: [],
    errors: [],
  };

  if (!existsSync(sourceDir)) {
    result.ok = false;
    result.errors.push(`source commands dir not found: ${sourceDir}`);
    return result;
  }

  const targets = resolveTargets(options.target);
  const scopes = resolveScopes(options.scope);

  for (const target of targets) {
    if (target === "codex") {
      const src = path.join(sourceDir, "codex");
      const dest = codexPromptsDir();
      const copied = await copyDir(src, dest, result.dryRun);
      const pruned = options.prune ? await pruneDirs(src, dest, result.dryRun) : 0;
      result.targets.push({
        target,
        scope: "global",
        destDir: dest,
        copiedFiles: copied.files,
        copiedDirs: copied.dirs,
        skipped: copied.skipped,
        pruned,
      });
      continue;
    }

    for (const scope of scopes) {
      if (scope === "project" && !options.repoDir) {
        result.ok = false;
        result.errors.push("repoDir required for project-scope Claude commands");
        continue;
      }
      const src =
        scope === "global"
          ? path.join(sourceDir, "claude", "global")
          : path.join(sourceDir, "claude", "project");
      const dest =
        scope === "global"
          ? claudeGlobalCommandsDir()
          : claudeProjectCommandsDir(options.repoDir ?? "");
      const copied = await copyDir(src, dest, result.dryRun);
      const pruned = options.prune ? await pruneDirs(src, dest, result.dryRun) : 0;
      result.targets.push({
        target,
        scope,
        destDir: dest,
        copiedFiles: copied.files,
        copiedDirs: copied.dirs,
        skipped: copied.skipped,
        pruned,
      });
    }
  }

  return result;
}
