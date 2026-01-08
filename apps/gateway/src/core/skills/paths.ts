import os from "node:os";
import path from "node:path";

export type SkillTarget = "codex" | "claude" | "both";

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function codexSkillsDir(): string {
  return path.join(homeDir(), ".codex", "skills");
}

export function claudeSkillsDir(): string {
  return path.join(homeDir(), ".claude", "skills");
}
