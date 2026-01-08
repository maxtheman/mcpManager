import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Json = unknown;

export type LockFile = {
  pid: number;
  acquiredAt: string;
  expiresAt: string;
};

export type ProcessInfo = {
  pid: number;
  command: string;
  alive: boolean;
};

export type TestContext = {
  tempDir: string;
  registryPath: string;
  locksDir: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

export type MonitoringSnapshot = {
  timestamp: string;
  lockFiles: Map<string, LockFile | null>;
  processes: ProcessInfo[];
  errors: string[];
};

export function die(msg: string): never {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

export function log(tag: string, message: string, level: "info" | "warn" | "error" = "info") {
  const prefix = level === "error" ? "[ERROR]" : level === "warn" ? "[WARN]" : "[INFO]";
  console.log(`${prefix} [${tag}] ${message}`);
}

export function parseJsonText(contentText: string): Json {
  try {
    return JSON.parse(contentText);
  } catch {
    return { raw: contentText };
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findChildProcesses(parentPid: number): Promise<ProcessInfo[]> {
  const proc = Bun.spawn({
    cmd: ["pgrep", "-P", String(parentPid)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const pids = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));

  const infos: ProcessInfo[] = [];
  for (const pid of pids) {
    const alive = await isProcessAlive(pid);
    const cmdProc = Bun.spawn({
      cmd: ["ps", "-p", String(pid), "-o", "command="],
      stdout: "pipe",
      stderr: "pipe",
    });
    const command = (await new Response(cmdProc.stdout).text()).trim();
    await cmdProc.exited;
    infos.push({ pid, command, alive });
  }
  return infos;
}

export async function findProcessesByName(pattern: string): Promise<ProcessInfo[]> {
  const proc = Bun.spawn({
    cmd: ["pgrep", "-f", pattern],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const pids = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));

  const infos: ProcessInfo[] = [];
  for (const pid of pids) {
    const alive = await isProcessAlive(pid);
    const cmdProc = Bun.spawn({
      cmd: ["ps", "-p", String(pid), "-o", "command="],
      stdout: "pipe",
      stderr: "pipe",
    });
    const command = (await new Response(cmdProc.stdout).text()).trim();
    await cmdProc.exited;
    infos.push({ pid, command, alive });
  }
  return infos;
}

export async function readLockFile(filePath: string): Promise<LockFile | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      typeof raw?.pid === "number" &&
      typeof raw?.acquiredAt === "string" &&
      typeof raw?.expiresAt === "string"
    ) {
      return raw as LockFile;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listLockFiles(locksDir: string): Promise<Map<string, LockFile | null>> {
  const result = new Map<string, LockFile | null>();
  if (!existsSync(locksDir)) return result;

  try {
    const files = await fs.readdir(locksDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(locksDir, file);
      const lock = await readLockFile(filePath);
      result.set(file.replace(".json", ""), lock);
    }
  } catch {
    return result;
  }
  return result;
}

export function isLockExpired(lock: LockFile): boolean {
  const expiresAt = Date.parse(lock.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function isLockValid(lock: LockFile | null): lock is LockFile {
  return lock !== null && !isLockExpired(lock);
}

export async function createTestContext(prefix: string): Promise<TestContext> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `mx-${prefix}-`));
  const registryPath = path.join(tempDir, "registry.json");
  const locksDir = path.join(tempDir, ".Mx", "locks");

  await fs.mkdir(locksDir, { recursive: true });

  const env: Record<string, string> = {
    HOME: tempDir,
    MX_REGISTRY_PATH: registryPath,
  };

	  const cleanup = async () => {
	    try {
	      await fs.rm(tempDir, { recursive: true, force: true });
	    } catch {
	      // best-effort cleanup
	    }
	  };

  return { tempDir, registryPath, locksDir, env, cleanup };
}

export async function writeTestRegistry(
  registryPath: string,
  upstreams: Array<{
    id: string;
    enabled?: boolean;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>
): Promise<void> {
  const registry = {
    version: 1,
    upstreams: upstreams.map((u) => ({
      id: u.id,
      enabled: u.enabled ?? true,
      command: u.command,
      args: u.args ?? [],
      env: u.env ?? {},
      env_vars: [],
    })),
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

export async function captureSnapshot(
  locksDir: string,
  processPatterns: string[] = []
): Promise<MonitoringSnapshot> {
  const errors: string[] = [];
  let lockFiles = new Map<string, LockFile | null>();
  const processes: ProcessInfo[] = [];

  try {
    lockFiles = await listLockFiles(locksDir);
  } catch (e) {
    errors.push(`Failed to list lock files: ${e}`);
  }

  for (const pattern of processPatterns) {
    try {
      const found = await findProcessesByName(pattern);
      processes.push(...found);
    } catch (e) {
      errors.push(`Failed to find processes matching "${pattern}": ${e}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    lockFiles,
    processes,
    errors,
  };
}

export function formatSnapshot(snapshot: MonitoringSnapshot): string {
  const lines: string[] = [];
  lines.push(`Snapshot at ${snapshot.timestamp}`);
  lines.push(`Lock files (${snapshot.lockFiles.size}):`);
  for (const [name, lock] of snapshot.lockFiles) {
    if (lock) {
      const expired = isLockExpired(lock) ? " [EXPIRED]" : "";
      lines.push(`  - ${name}: pid=${lock.pid}, expires=${lock.expiresAt}${expired}`);
    } else {
      lines.push(`  - ${name}: [invalid/missing]`);
    }
  }
  lines.push(`Processes (${snapshot.processes.length}):`);
  for (const proc of snapshot.processes) {
    const status = proc.alive ? "alive" : "dead";
    lines.push(`  - pid=${proc.pid} (${status}): ${proc.command.slice(0, 80)}`);
  }
  if (snapshot.errors.length > 0) {
    lines.push(`Errors (${snapshot.errors.length}):`);
    for (const err of snapshot.errors) {
      lines.push(`  - ${err}`);
    }
  }
  return lines.join("\n");
}

export class TestAssertions {
  private failures: string[] = [];
  private tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  assert(condition: boolean, message: string): void {
    if (!condition) {
      const msg = `[${this.tag}] Assertion failed: ${message}`;
      this.failures.push(msg);
      log(this.tag, message, "error");
    }
  }

  assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
      const msg = `[${this.tag}] ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
      this.failures.push(msg);
      log(this.tag, msg, "error");
    }
  }

  assertNotEqual<T>(actual: T, notExpected: T, message: string): void {
    if (actual === notExpected) {
      const msg = `[${this.tag}] ${message}: expected NOT ${JSON.stringify(notExpected)}, but got it`;
      this.failures.push(msg);
      log(this.tag, msg, "error");
    }
  }

  assertContains(haystack: string, needle: string, message: string): void {
    if (!haystack.includes(needle)) {
      const msg = `[${this.tag}] ${message}: expected to contain "${needle}"`;
      this.failures.push(msg);
      log(this.tag, msg, "error");
    }
  }

  hasFailures(): boolean {
    return this.failures.length > 0;
  }

  getFailures(): string[] {
    return [...this.failures];
  }

  throwIfFailed(): void {
    if (this.failures.length > 0) {
      die(`Test failed with ${this.failures.length} assertion(s):\n${this.failures.join("\n")}`);
    }
  }
}

export async function ensureGatewayBinary(): Promise<string> {
  const gatewayExe = path.join(import.meta.dir, "..", "dist", "Mx-gateway");

  if (process.env.MX_SKIP_BUILD === "1" && existsSync(gatewayExe)) {
    return gatewayExe;
  }

  log("build", "Building gateway binary...");
  const proc = Bun.spawn(["bun", "run", "build:exe"], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) die("Failed to build gateway (bun run build:exe).");
  if (!existsSync(gatewayExe)) die(`Gateway binary missing at ${gatewayExe}`);

  return gatewayExe;
}
