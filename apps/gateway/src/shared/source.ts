import os from "node:os";
import path from "node:path";

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function sourceDir(): string {
  return process.env.MX_SOURCE_DIR ?? path.join(homeDir(), ".Mx", "source");
}

export function sourceRegistryPath(): string {
  return path.join(sourceDir(), "registry.json");
}

export function sourceSkillsDir(): string {
  return path.join(sourceDir(), "skills");
}

export function sourceCommandsDir(): string {
  return path.join(sourceDir(), "commands");
}
