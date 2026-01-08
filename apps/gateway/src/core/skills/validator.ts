import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { claudeSkillsDir, codexSkillsDir, type SkillTarget } from "./paths.js";

type ValidationLevel = "error" | "warning";
type ValidationIssue = {
  path: string;
  target: "codex" | "claude";
  code: string;
  message: string;
  level: ValidationLevel;
};

type SkillRecord = {
  path: string;
  target: "codex" | "claude";
  hasFrontmatter: boolean;
  name?: string;
  description?: string;
  fixed?: boolean;
  issues: ValidationIssue[];
};

type ValidationReport = {
  ok: boolean;
  target: SkillTarget;
  scanned: number;
  errors: number;
  warnings: number;
  fixed: number;
  skills: SkillRecord[];
  issues: ValidationIssue[];
};

type ValidateOptions = {
  target?: SkillTarget;
  skillDirs?: string[];
  autofix?: boolean;
  backup?: boolean;
  errorsOnly?: boolean;
};

type FrontmatterResult = {
  hasFrontmatter: boolean;
  name?: string;
  description?: string;
  frontmatterLines?: string[];
  body: string;
};

function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".");
}

function isHiddenPath(filePath: string): boolean {
  return filePath.split(path.sep).some((segment) => isHiddenSegment(segment));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { hasFrontmatter: false, body: text };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { hasFrontmatter: false, body: text };
  }
  const fmLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n");
  const result: FrontmatterResult = { hasFrontmatter: true, body, frontmatterLines: fmLines };
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1);
    const value = stripQuotes(rawValue);
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

function deriveName(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  const base = dir || path.basename(filePath, path.extname(filePath));
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 100) || "skill";
}

function deriveDescription(body: string, name: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  let candidate = lines.find((line) => line.length > 0) ?? "";
  if (candidate.startsWith("#")) {
    candidate = candidate.replace(/^#+\s*/, "");
  }
  const desc = candidate.length > 0 ? candidate : `Skill for ${name}.`;
  return desc.slice(0, 500);
}

async function backupFile(filePath: string) {
  const backup = `${filePath}.bak.${Math.floor(Date.now() / 1000)}`;
  await fs.copyFile(filePath, backup);
}

function buildFrontmatterBlock(name: string, description: string, existingLines?: string[]): string[] {
  const lines: string[] = existingLines ? [...existingLines] : [];
  const hasName = lines.some((line) => line.trim().startsWith("name:"));
  const hasDescription = lines.some((line) => line.trim().startsWith("description:"));
  if (!hasName) lines.push(`name: ${name}`);
  if (!hasDescription) lines.push(`description: ${description}`);
  return ["---", ...lines, "---"];
}

async function applyAutofix(filePath: string, parsed: FrontmatterResult): Promise<FrontmatterResult> {
  const raw = await fs.readFile(filePath, "utf8");
  const current = parsed.hasFrontmatter ? parsed : parseFrontmatter(raw);
  const name = current.name?.trim() || deriveName(filePath);
  const description = current.description?.trim() || deriveDescription(current.body, name);
  const trimmedName = name.slice(0, 100);
  const trimmedDescription = description.slice(0, 500);

  const frontmatter = buildFrontmatterBlock(trimmedName, trimmedDescription, current.frontmatterLines);
  const newText = `${frontmatter.join("\n")}\n${current.body}`;
  await fs.writeFile(filePath, newText, "utf8");
  return parseFrontmatter(newText);
}

function issue(filePath: string, target: "codex" | "claude", code: string, message: string, level: ValidationLevel) {
  return { path: filePath, target, code, message, level } satisfies ValidationIssue;
}

function validateCodexSkill(filePath: string, parsed: FrontmatterResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!parsed.hasFrontmatter) {
    issues.push(issue(filePath, "codex", "missing_frontmatter", "Missing frontmatter block.", "error"));
    return issues;
  }
  const name = parsed.name?.trim() ?? "";
  const description = parsed.description?.trim() ?? "";
  if (!name) {
    issues.push(issue(filePath, "codex", "missing_name", "Missing name field in frontmatter.", "error"));
  } else if (name.length > 100) {
    issues.push(issue(filePath, "codex", "name_too_long", "Name exceeds 100 characters.", "error"));
  }
  if (!description) {
    issues.push(issue(filePath, "codex", "missing_description", "Missing description field in frontmatter.", "error"));
  } else if (description.length > 500) {
    issues.push(
      issue(filePath, "codex", "description_too_long", "Description exceeds 500 characters.", "error"),
    );
  }
  return issues;
}

async function walkSkillDir(
  root: string,
  mode: "codex" | "claude",
  out: string[],
) {
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

async function discoverSkills(
  target: "codex" | "claude",
  skillDirs: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const dir of skillDirs) {
    await walkSkillDir(dir, target, out);
  }
  return out.filter((filePath) => !isHiddenPath(filePath));
}

export async function validateSkills(options: ValidateOptions = {}): Promise<ValidationReport> {
  const target = options.target ?? "both";
  const targets: Array<"codex" | "claude"> = target === "both" ? ["codex", "claude"] : [target];
  const reports: SkillRecord[] = [];
  const issues: ValidationIssue[] = [];
  let fixed = 0;

  for (const t of targets) {
    let dirs: string[];
    if (options.skillDirs && options.skillDirs.length > 0) {
      dirs = options.skillDirs;
    } else if (t === "codex") {
      dirs = [codexSkillsDir()];
    } else {
      dirs = [claudeSkillsDir()];
    }
    const skills = await discoverSkills(t, dirs);
    for (const skillPath of skills) {
      const raw = await fs.readFile(skillPath, "utf8");
      let parsed = parseFrontmatter(raw);
      let skillIssues = t === "codex" ? validateCodexSkill(skillPath, parsed) : [];
      let wasFixed = false;
      if (options.autofix && t === "codex" && skillIssues.length > 0) {
        if (options.backup) await backupFile(skillPath);
        parsed = await applyAutofix(skillPath, parsed);
        skillIssues = validateCodexSkill(skillPath, parsed);
        wasFixed = skillIssues.length === 0;
        if (wasFixed) fixed += 1;
      }
      reports.push({
        path: skillPath,
        target: t,
        hasFrontmatter: parsed.hasFrontmatter,
        name: parsed.name,
        description: parsed.description,
        fixed: wasFixed ? true : undefined,
        issues: skillIssues,
      });
      issues.push(...skillIssues);
    }
  }

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  const scanned = reports.length;
  return {
    ok: errors === 0,
    target,
    scanned,
    errors,
    warnings,
    fixed,
    skills: options.errorsOnly ? reports.filter((r) => r.issues.length > 0) : reports,
    issues: options.errorsOnly ? issues.filter((i) => i.level === "error") : issues,
  };
}

export function formatValidationText(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`target: ${report.target}`);
  lines.push(`scanned: ${report.scanned}`);
  lines.push(`errors: ${report.errors}`);
  lines.push(`warnings: ${report.warnings}`);
  lines.push(`fixed: ${report.fixed}`);
  if (report.issues.length === 0) return lines.join("\n");
  lines.push("");
  for (const issueItem of report.issues) {
    lines.push(`[${issueItem.target}] ${issueItem.code} ${issueItem.path}`);
    lines.push(`  ${issueItem.message}`);
  }
  return lines.join("\n");
}
