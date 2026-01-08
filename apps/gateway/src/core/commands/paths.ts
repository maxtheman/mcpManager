import os from "node:os";
import path from "node:path";

export type CommandTarget = "codex" | "claude" | "both";
export type CommandScope = "global" | "project" | "both";

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function claudeGlobalCommandsDir(): string {
  return path.join(homeDir(), ".claude", "commands");
}

export function claudeProjectCommandsDir(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "commands");
}

export function codexPromptsDir(): string {
  return path.join(homeDir(), ".codex", "prompts");
}
