import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { claudeSkillsDir, codexSkillsDir, type SkillTarget } from "./paths.js";

type SkillAnalysis = {
  target: SkillTarget;
  scanned: number;
  totalBytes: number;
  averageBytes: number;
  maxBytes: number;
  missingFrontmatter: number;
  missingName: number;
  missingDescription: number;
};

type AnalyzeOptions = {
  target?: SkillTarget;
  skillDirs?: string[];
};

type FrontmatterInfo = {
  hasFrontmatter: boolean;
  name?: string;
  description?: string;
};

function parseFrontmatter(text: string): FrontmatterInfo {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { hasFrontmatter: false };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { hasFrontmatter: false };
  const fmLines = lines.slice(1, endIndex);
  const info: FrontmatterInfo = { hasFrontmatter: true };
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") info.name = value;
    if (key === "description") info.description = value;
  }
  return info;
}

async function walkSkillDir(root: string, mode: "codex" | "claude", out: string[]) {
  if (!existsSync(root)) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await walkSkillDir(full, mode, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (mode === "codex" && entry.name === "SKILL.md") out.push(full);
    if (mode === "claude" && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
}

async function discoverSkills(target: "codex" | "claude", skillDirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of skillDirs) {
    await walkSkillDir(dir, target, out);
  }
  return out;
}

export async function analyzeSkills(options: AnalyzeOptions = {}): Promise<SkillAnalysis> {
  const target = options.target ?? "both";
  const targets: Array<"codex" | "claude"> = target === "both" ? ["codex", "claude"] : [target];
  const overrideDirs = options.skillDirs && options.skillDirs.length > 0 ? options.skillDirs : null;

  let scanned = 0;
  let totalBytes = 0;
  let maxBytes = 0;
  let missingFrontmatter = 0;
  let missingName = 0;
  let missingDescription = 0;

  for (const t of targets) {
    const dirs = overrideDirs ?? (t === "codex" ? [codexSkillsDir()] : [claudeSkillsDir()]);
    const files = await discoverSkills(t, dirs);
    for (const filePath of files) {
      const raw = await fs.readFile(filePath, "utf8");
      const info = parseFrontmatter(raw);
      const size = Buffer.byteLength(raw, "utf8");
      scanned += 1;
      totalBytes += size;
      if (size > maxBytes) maxBytes = size;
      if (t === "codex") {
        if (!info.hasFrontmatter) missingFrontmatter += 1;
        if (!info.name) missingName += 1;
        if (!info.description) missingDescription += 1;
      }
    }
  }

  const averageBytes = scanned > 0 ? Math.round(totalBytes / scanned) : 0;
  return {
    target,
    scanned,
    totalBytes,
    averageBytes,
    maxBytes,
    missingFrontmatter,
    missingName,
    missingDescription,
  };
}

export function formatAnalysisText(report: SkillAnalysis): string {
  return [
    `target: ${report.target}`,
    `scanned: ${report.scanned}`,
    `total_bytes: ${report.totalBytes}`,
    `average_bytes: ${report.averageBytes}`,
    `max_bytes: ${report.maxBytes}`,
    `missing_frontmatter: ${report.missingFrontmatter}`,
    `missing_name: ${report.missingName}`,
    `missing_description: ${report.missingDescription}`,
  ].join("\n");
}
