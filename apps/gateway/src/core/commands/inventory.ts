import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { sourceCommandsDir } from "../../shared/source.js";

export type CommandSummary = {
  target: "claude" | "codex";
  scope: "global" | "project";
  name: string;
  relativePath: string;
};

async function listCommandsInDir(root: string): Promise<Array<{ name: string; relativePath: string }>> {
  const out: Array<{ name: string; relativePath: string }> = [];
  if (!existsSync(root)) return out;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) continue;
    if (!stat.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    out.push({
      name: entry.name.replace(/\\.md$/i, ""),
      relativePath: path.relative(root, full),
    });
  }
  return out;
}

export async function listSourceCommands(sourceDir = sourceCommandsDir()): Promise<CommandSummary[]> {
  const out: CommandSummary[] = [];
  const claudeGlobal = path.join(sourceDir, "claude", "global");
  const claudeProject = path.join(sourceDir, "claude", "project");
  const codex = path.join(sourceDir, "codex");

  const claudeGlobalCmds = await listCommandsInDir(claudeGlobal);
  for (const cmd of claudeGlobalCmds) {
    out.push({ target: "claude", scope: "global", name: cmd.name, relativePath: cmd.relativePath });
  }
  const claudeProjectCmds = await listCommandsInDir(claudeProject);
  for (const cmd of claudeProjectCmds) {
    out.push({ target: "claude", scope: "project", name: cmd.name, relativePath: cmd.relativePath });
  }
  const codexCmds = await listCommandsInDir(codex);
  for (const cmd of codexCmds) {
    out.push({ target: "codex", scope: "global", name: cmd.name, relativePath: cmd.relativePath });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
