import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export type PoolStatus = {
  upstreamId: string;
  locked: boolean;
  heldByThisProcess: boolean;
  lock?: {
    pid: number;
    acquiredAt: string;
    expiresAt: string;
  };
};

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function locksDir(): string {
  return path.join(homeDir(), ".mcpmanager", "locks");
}

function lockPath(upstreamId: string): string {
  // File name must be filesystem-safe.
  const safe = upstreamId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(locksDir(), `${safe}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIds(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function configuredPoolIds(): string[] {
  return parseIds(process.env.MCPMANAGER_PLAYWRIGHT_POOL);
}

export function poolEnabled(): boolean {
  return configuredPoolIds().length > 0;
}

export async function readLock(upstreamId: string): Promise<PoolStatus["lock"] | null> {
  const p = lockPath(upstreamId);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8"));
    if (
      typeof raw?.pid === "number" &&
      typeof raw?.acquiredAt === "string" &&
      typeof raw?.expiresAt === "string"
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

export function isExpired(lock: PoolStatus["lock"]): boolean {
  if (!lock) return true;
  const expiresAt = Date.parse(lock.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export async function tryAcquireLock(
  upstreamId: string,
  ttlSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await fs.mkdir(locksDir(), { recursive: true });
  const p = lockPath(upstreamId);

  const existing = await readLock(upstreamId);
  if (existing && !isExpired(existing)) {
    return { ok: false, reason: `Locked by pid ${existing.pid} until ${existing.expiresAt}` };
  }
  if (existing && isExpired(existing)) {
    try {
      await fs.unlink(p);
    } catch {
      // ignore
    }
  }

  const acquiredAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const payload = JSON.stringify(
    { pid: process.pid, acquiredAt, expiresAt },
    null,
    2,
  );

  try {
    // Atomic create.
    const f = await fs.open(p, "wx");
    await f.writeFile(payload, "utf8");
    await f.close();
    return { ok: true };
  } catch (e: any) {
    if (String(e?.code) === "EEXIST") {
      return { ok: false, reason: "Already locked" };
    }
    return { ok: false, reason: String(e) };
  }
}

export async function releaseLock(upstreamId: string): Promise<void> {
  const p = lockPath(upstreamId);
  if (!existsSync(p)) return;
  const lock = await readLock(upstreamId);
  if (lock && lock.pid !== process.pid) return;
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

export async function listPoolStatus(held: Set<string>): Promise<PoolStatus[]> {
  const ids = configuredPoolIds();
  const out: PoolStatus[] = [];
  for (const upstreamId of ids) {
    const lock = await readLock(upstreamId);
    const locked = Boolean(lock && !isExpired(lock));
    out.push({
      upstreamId,
      locked,
      heldByThisProcess: held.has(upstreamId),
      lock: locked ? lock ?? undefined : undefined,
    });
  }
  return out;
}
