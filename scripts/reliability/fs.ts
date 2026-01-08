import fs from "node:fs";
import path from "node:path";

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!isDir(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
      walk(full, exts, out);
    } else if (entry.isFile()) {
      if (exts.some((e) => full.endsWith(e))) out.push(full);
    }
  }
  return out;
}
