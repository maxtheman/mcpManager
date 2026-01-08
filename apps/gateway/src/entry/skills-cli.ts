import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { validateSkills, formatValidationText } from "../core/skills/validator.js";
import { analyzeSkills, formatAnalysisText } from "../core/skills/analyzer.js";
import { syncSkillsFromSource, formatSkillSyncText } from "../core/skills/sync.js";
import { sourceDir } from "../shared/source.js";
import {
  defaultSkillsManifest,
  isSkillEnabled,
  readSkillsManifest,
  skillsManifestPath,
  writeSkillsManifest,
  type SkillManifestTarget,
  type SkillsManifest,
} from "../core/skills/manifest.js";

type ParsedArgs = {
  cmd: string;
  target?: "codex" | "claude" | "both";
  format?: "text" | "json";
  autofix?: boolean;
  backup?: boolean;
  errorsOnly?: boolean;
  skillDirs: string[];
  sourceDir?: string;
  dryRun?: boolean;
  prune?: boolean;
  positional: string[];
};

function resolveCliPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  const base = process.env.INIT_CWD ?? process.cwd();
  return path.resolve(base, inputPath);
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[2] ?? "help";
  const args: ParsedArgs = { cmd, skillDirs: [], positional: [] };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--target":
        args.target = argv[i + 1] as any;
        i += 1;
        break;
      case "--format":
        args.format = argv[i + 1] as any;
        i += 1;
        break;
      case "--autofix":
        args.autofix = true;
        break;
      case "--backup":
        args.backup = true;
        break;
      case "--errors-only":
        args.errorsOnly = true;
        break;
      case "--skill-dir":
        if (argv[i + 1]) args.skillDirs.push(argv[i + 1]);
        i += 1;
        break;
      case "--source-dir":
        if (argv[i + 1]) args.sourceDir = argv[i + 1];
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--prune":
        args.prune = true;
        break;
      default:
        if (!arg.startsWith("-")) args.positional.push(arg);
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "skills",
      "",
      "Usage:",
      "  skills validate [--target codex|claude|both] [--autofix] [--backup] [--format text|json] [--errors-only] [--skill-dir <path>]",
      "  skills analyze [--target codex|claude|both] [--format text|json] [--skill-dir <path>]",
      "  skills sync [--source-dir <root>] [--target codex|claude|both] [--dry-run] [--prune] [--format text|json]",
      "  skills manifest init [--source-dir <root>] [--format text|json]",
      "  skills manifest list [--source-dir <root>] [--format text|json]",
      "  skills manifest enable <id> [--target codex|claude|both] [--source-dir <root>] [--format text|json]",
      "  skills manifest disable <id> [--target codex|claude|both] [--source-dir <root>] [--format text|json]",
      "",
      "Notes:",
      "  --source-dir points to the source root that contains registry.json and skills/.",
      "  When omitted, source defaults to MX_SOURCE_DIR or ~/.Mx/source.",
    ].join("\n"),
  );
}

async function runValidate(args: ParsedArgs) {
  const report = await validateSkills({
    target: args.target ?? "both",
    skillDirs: args.skillDirs.length > 0 ? args.skillDirs.map(resolveCliPath) : undefined,
    autofix: args.autofix,
    backup: args.backup,
    errorsOnly: args.errorsOnly,
  });
  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  console.log(formatValidationText(report));
  process.exit(report.ok ? 0 : 1);
}

async function runAnalyze(args: ParsedArgs) {
  const report = await analyzeSkills({
    target: args.target ?? "both",
    skillDirs: args.skillDirs.length > 0 ? args.skillDirs.map(resolveCliPath) : undefined,
  });
  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatAnalysisText(report));
}

async function runSync(args: ParsedArgs) {
  const root = args.sourceDir ? resolveCliPath(args.sourceDir) : sourceDir();
  const report = await syncSkillsFromSource({
    sourceDir: path.join(root, "skills"),
    target: args.target ?? "both",
    dryRun: args.dryRun,
    prune: args.prune,
  });
  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  console.log(formatSkillSyncText(report));
  process.exit(report.ok ? 0 : 1);
}

async function listTopLevelSkillDirs(skillsRoot: string): Promise<string[]> {
  if (!existsSync(skillsRoot)) return [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function setManifestSkillEnabled(
  manifest: SkillsManifest,
  id: string,
  target: SkillManifestTarget | "both",
  enabled: boolean,
) {
  const skills = (manifest.skills ??= {});
  if (target === "both") {
    skills[id] = enabled;
    return;
  }

  const existing = skills[id];
  const next: { codex?: boolean; claude?: boolean } =
    existing === undefined
      ? {}
      : typeof existing === "boolean"
        ? { codex: existing, claude: existing }
        : { ...existing };
  next[target] = enabled;

  const codexVal = next.codex;
  const claudeVal = next.claude;
  if (typeof codexVal === "boolean" && typeof claudeVal === "boolean" && codexVal === claudeVal) {
    skills[id] = codexVal;
    return;
  }

  skills[id] = next;
}

async function runManifest(args: ParsedArgs) {
  const action = args.positional[0] ?? "help";
  const id = args.positional[1];

  const root = args.sourceDir ? resolveCliPath(args.sourceDir) : sourceDir();
  const skillsRoot = path.join(root, "skills");
  const manifestPath = skillsManifestPath(skillsRoot);

  if (action === "init") {
    const dirs = await listTopLevelSkillDirs(skillsRoot);
    const manifest = defaultSkillsManifest();
    for (const dir of dirs) setManifestSkillEnabled(manifest, dir, "both", true);
    await writeSkillsManifest(skillsRoot, manifest);
    const out = { ok: true, manifest_path: manifestPath, skills: dirs };
    if (args.format === "json") {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(`wrote ${out.manifest_path}`);
    console.log(`skills: ${dirs.length}`);
    return;
  }

  const existing = await readSkillsManifest(skillsRoot);
  if (!existing.ok) {
    if (args.format === "json") {
      console.log(JSON.stringify({ ok: false, error: `Invalid manifest at ${existing.path}: ${existing.error}` }, null, 2));
      process.exit(1);
    }
    console.error(`Invalid manifest at ${existing.path}: ${existing.error}`);
    process.exit(1);
  }

  const manifest: SkillsManifest = existing.exists ? existing.manifest : defaultSkillsManifest();

  if (action === "list") {
    const dirs = await listTopLevelSkillDirs(skillsRoot);
    const rows = dirs.map((dir) => ({
      id: dir,
      codex: isSkillEnabled(existing.exists ? existing.manifest : null, dir, "codex"),
      claude: isSkillEnabled(existing.exists ? existing.manifest : null, dir, "claude"),
      source_path: path.join(skillsRoot, dir),
    }));
    const out = {
      ok: true,
      manifest_path: manifestPath,
      manifest_exists: existing.exists,
      skills_root: skillsRoot,
      skills: rows,
    };
    if (args.format === "json") {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(`skills_root: ${skillsRoot}`);
    console.log(`manifest: ${out.manifest_path} (${existing.exists ? "present" : "absent"})`);
    for (const row of rows) {
      console.log(`- ${row.id} (codex=${row.codex}, claude=${row.claude}) ${row.source_path}`);
    }
    return;
  }

  if (action === "enable" || action === "disable") {
    if (!id) {
      if (args.format === "json") {
        console.log(JSON.stringify({ ok: false, error: "skill id required" }, null, 2));
        process.exit(1);
      }
      console.error("skill id required");
      process.exit(1);
    }
    const target = args.target ?? "both";
    setManifestSkillEnabled(manifest, id, target, action === "enable");
    await writeSkillsManifest(skillsRoot, manifest);
    const out = {
      ok: true,
      action,
      id,
      target,
      manifest_path: manifestPath,
    };
    if (args.format === "json") {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(`${action}d ${id} (target=${target})`);
    console.log(`manifest: ${out.manifest_path}`);
    return;
  }

  printHelp();
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.cmd) {
    case "validate":
      await runValidate(args);
      return;
    case "analyze":
      await runAnalyze(args);
      return;
    case "sync":
      await runSync(args);
      return;
    case "manifest":
      await runManifest(args);
      return;
    case "help":
    default:
      printHelp();
  }
}

await main();
