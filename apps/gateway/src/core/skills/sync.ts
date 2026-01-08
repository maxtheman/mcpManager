import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { sourceSkillsDir } from "../../shared/source.js";

import { isSkillEnabled, readSkillsManifest, skillsManifestPath } from "./manifest.js";
import { claudeSkillsDir, codexSkillsDir } from "./paths.js";

type SkillSyncTarget = "codex" | "claude" | "both";

export type SkillSyncOptions = {
  sourceDir?: string;
  target?: SkillSyncTarget;
  dryRun?: boolean;
  prune?: boolean;
};

export type SkillSyncResult = {
  ok: boolean;
  sourceDir: string;
  manifestPath: string;
  manifestUsed: boolean;
  dryRun: boolean;
  targets: Array<{
    target: "codex" | "claude";
    destDir: string;
    copiedFiles: number;
    copiedDirs: number;
    skipped: number;
    disabled: number;
    pruned: number;
  }>;
  errors: string[];
};

function isHidden(entry: string): boolean {
  return entry.startsWith(".");
}

async function copyTree(
  src: string,
  dest: string,
  dryRun: boolean,
): Promise<{ files: number; dirs: number; skipped: number }> {
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
      const nested = await copyTree(srcPath, destPath, dryRun);
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

async function pruneDirs(allowed: Set<string>, destRoot: string, dryRun: boolean): Promise<number> {
  if (!existsSync(destRoot)) return 0;
  const destDirs = await listTopLevelDirs(destRoot);
  let removed = 0;
  for (const dir of destDirs) {
    if (allowed.has(dir)) continue;
    removed += 1;
    if (!dryRun) {
      await fs.rm(path.join(destRoot, dir), { recursive: true, force: true });
    }
  }
  return removed;
}

function resolveTargets(target: SkillSyncTarget | undefined): Array<"codex" | "claude"> {
  if (!target || target === "both") return ["codex", "claude"];
  return [target];
}

export async function syncSkillsFromSource(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
  const sourceDir = options.sourceDir ?? sourceSkillsDir();
  const manifestPath = skillsManifestPath(sourceDir);
  const result: SkillSyncResult = {
    ok: true,
    sourceDir,
    manifestPath,
    manifestUsed: false,
    dryRun: options.dryRun === true,
    targets: [],
    errors: [],
  };

  if (!existsSync(sourceDir)) {
    result.ok = false;
    result.errors.push(`source skills dir not found: ${sourceDir}`);
    return result;
  }

  const manifest = await readSkillsManifest(sourceDir);
  if (!manifest.ok) {
    result.ok = false;
    result.errors.push(`Invalid skills manifest at ${manifest.path}: ${manifest.error}`);
    return result;
  }
  result.manifestUsed = manifest.exists;

  const allSkillDirs = await listTopLevelDirs(sourceDir);
  const allowedForTarget = (target: "codex" | "claude"): Set<string> => {
    if (!manifest.exists) return new Set(allSkillDirs);
    const allowed = new Set<string>();
    for (const dir of allSkillDirs) {
      if (isSkillEnabled(manifest.manifest, dir, target)) allowed.add(dir);
    }
    return allowed;
  };

  for (const target of resolveTargets(options.target)) {
    const destDir = target === "codex" ? codexSkillsDir() : claudeSkillsDir();
    const allowed = allowedForTarget(target);
    const disabled = Array.from(allSkillDirs).filter((dir) => !allowed.has(dir)).length;

    let copiedFiles = 0;
    let copiedDirs = 0;
    let skipped = 0;
    for (const dir of allowed) {
      const srcPath = path.join(sourceDir, dir);
      const stat = await fs.lstat(srcPath);
      if (stat.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (!stat.isDirectory()) {
        skipped += 1;
        continue;
      }
      const destPath = path.join(destDir, dir);
      const nested = await copyTree(srcPath, destPath, result.dryRun);
      copiedFiles += nested.files;
      copiedDirs += 1 + nested.dirs;
      skipped += nested.skipped;
    }

    const pruned = options.prune ? await pruneDirs(allowed, destDir, result.dryRun) : 0;
    result.targets.push({
      target,
      destDir,
      copiedFiles,
      copiedDirs,
      skipped,
      disabled,
      pruned,
    });
  }

  return result;
}

export function formatSkillSyncText(report: SkillSyncResult): string {
  const lines: string[] = [];
  lines.push(`source_dir: ${report.sourceDir}`);
  lines.push(`manifest: ${report.manifestPath} (${report.manifestUsed ? "used" : "absent"})`);
  lines.push(`dry_run: ${report.dryRun}`);
  for (const target of report.targets) {
    lines.push(`- target: ${target.target}`);
    lines.push(`  dest_dir: ${target.destDir}`);
    lines.push(`  copied_files: ${target.copiedFiles}`);
    lines.push(`  copied_dirs: ${target.copiedDirs}`);
    lines.push(`  skipped: ${target.skipped}`);
    lines.push(`  disabled: ${target.disabled}`);
    lines.push(`  pruned: ${target.pruned}`);
  }
  if (report.errors.length > 0) {
    lines.push("errors:");
    for (const err of report.errors) lines.push(`- ${err}`);
  }
  return lines.join("\n");
}
