import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PoolLock = {
  pid: number;
  acquiredAt: string;
  expiresAt: string;
};

type PoolStatus = {
  upstreamId: string;
  lockPath: string;
  locked: boolean;
  heldByThisProcess: boolean;
  availableForThisProcess: boolean;
  lock?: {
    pid: number;
    acquiredAt: string;
    expiresAt: string;
    pidAlive: boolean;
    expired: boolean;
  };
  reason?:
    | "free"
    | "held_by_this_process"
    | "locked"
    | "stale_dead_pid"
    | "stale_expired"
    | "corrupt_lock_file";
  note?: string;
};

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function locksDir(): string {
  return path.join(homeDir(), ".Mx", "locks");
}

function lockPath(upstreamId: string): string {
  // File name must be filesystem-safe.
  const safe = upstreamId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(locksDir(), `${safe}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we don't have permission.
    if (String(e?.code) === "EPERM") return true;
    return false;
  }
}

function parseIds(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let poolIdsOverride: string[] | null = null;

export function setPoolIdsOverride(ids: string[] | null) {
  poolIdsOverride = ids;
}

export function parsePoolIds(raw: string | undefined): string[] {
  return parseIds(raw);
}

export function configuredPoolIds(): string[] {
  if (poolIdsOverride) return poolIdsOverride;
  return parseIds(process.env.MX_PLAYWRIGHT_POOL);
}

export function poolEnabled(): boolean {
  return configuredPoolIds().length > 0;
}

type LockReadResult =
  | { kind: "absent"; path: string }
  | { kind: "valid"; path: string; lock: PoolLock }
  | { kind: "corrupt"; path: string; error: string };

async function readLockFile(upstreamId: string): Promise<LockReadResult> {
  const p = lockPath(upstreamId);
  if (!existsSync(p)) return { kind: "absent", path: p };
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8"));
    if (
      typeof raw?.pid === "number" &&
      typeof raw?.acquiredAt === "string" &&
      typeof raw?.expiresAt === "string"
    ) {
      return { kind: "valid", path: p, lock: raw };
    }
    return { kind: "corrupt", path: p, error: "Invalid lock file shape" };
  } catch (e) {
    return { kind: "corrupt", path: p, error: String(e) };
  }
}

function isExpired(lock: PoolLock): boolean {
  const expiresAt = Date.parse(lock.expiresAt);
  // Treat invalid timestamps as expired so we don't wedge the pool.
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= Date.now();
}

export async function tryAcquireLock(
  upstreamId: string,
  ttlSeconds: number,
): Promise<{ ok: true; reused?: boolean } | { ok: false; reason: string }> {
  await fs.mkdir(locksDir(), { recursive: true });

  const acquiredAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const payload = JSON.stringify(
    { pid: process.pid, acquiredAt, expiresAt },
    null,
    2,
  );

  const p = lockPath(upstreamId);
  const tryCreate = async (): Promise<{ ok: true } | { ok: false; reason: string; code?: string }> => {
    try {
      // Atomic create.
      const f = await fs.open(p, "wx");
      await f.writeFile(payload, "utf8");
      await f.close();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: String(e), code: String(e?.code ?? "") };
    }
  };

  // Keep the retry count low; this is a best-effort lock with stale cleanup.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readLockFile(upstreamId);

    if (existing.kind === "valid") {
      const lock = existing.lock;
      if (lock.pid === process.pid) {
        // Idempotent: refresh TTL for the current process.
        try {
          await fs.writeFile(existing.path, payload, "utf8");
        } catch (e) {
          return { ok: false, reason: `Failed to refresh lock: ${String(e)}` };
        }
        return { ok: true, reused: true };
      }

      const stale = isExpired(lock) || !isPidAlive(lock.pid);
      if (stale) {
        try {
          await fs.unlink(existing.path);
        } catch {
          // ignore and fall through to create attempt
        }
      } else {
        return { ok: false, reason: `Locked by pid ${lock.pid} until ${lock.expiresAt}` };
      }
    } else if (existing.kind === "corrupt") {
      try {
        await fs.unlink(existing.path);
      } catch (e) {
        return { ok: false, reason: `Corrupt lock file at ${existing.path}: ${existing.error} (${String(e)})` };
      }
    }

    const created = await tryCreate();
    if (created.ok) return { ok: true };
    if (created.code === "EEXIST") continue;
    return { ok: false, reason: created.reason };
  }

  const final = await readLockFile(upstreamId);
  if (final.kind === "valid" && !isExpired(final.lock)) {
    return { ok: false, reason: `Locked by pid ${final.lock.pid} until ${final.lock.expiresAt}` };
  }
  if (final.kind === "corrupt") {
    return { ok: false, reason: `Corrupt lock file at ${final.path}: ${final.error}` };
  }
  return { ok: false, reason: "Already locked" };
}

export async function releaseLock(
  upstreamId: string,
): Promise<{ ok: true; released: boolean } | { ok: false; reason: string }> {
  const p = lockPath(upstreamId);
  if (!existsSync(p)) return { ok: true, released: false };

  const existing = await readLockFile(upstreamId);
  if (existing.kind === "valid") {
    const lock = existing.lock;
    const stale = isExpired(lock) || !isPidAlive(lock.pid);
    if (!stale && lock.pid !== process.pid) {
      return { ok: false, reason: `Lock held by pid ${lock.pid} until ${lock.expiresAt}` };
    }
  }
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
  return { ok: true, released: true };
}

function describePoolStatus(params: {
  existing: LockReadResult;
  lock: PoolLock | null;
  expired: boolean;
  pidAlive: boolean;
  locked: boolean;
}): { reason: PoolStatus["reason"]; note?: string } {
  const { existing, lock, expired, pidAlive, locked } = params;
  if (existing.kind === "corrupt") {
    return { reason: "corrupt_lock_file", note: `corrupt lock file: ${existing.error}` };
  }
  if (lock && expired) {
    return { reason: "stale_expired", note: `stale lock: expired at ${lock.expiresAt}` };
  }
  if (lock && !pidAlive) {
    return { reason: "stale_dead_pid", note: `stale lock: pid ${lock.pid} not running` };
  }
  if (lock && locked) {
    return { reason: "locked" };
  }
  return { reason: "free" };
}

export async function listPoolStatus(held: Set<string>): Promise<PoolStatus[]> {
  const ids = configuredPoolIds();
  const out: PoolStatus[] = [];
  for (const upstreamId of ids) {
    const p = lockPath(upstreamId);
    const existing = await readLockFile(upstreamId);
    const lock = existing.kind === "valid" ? existing.lock : null;
    const expired = Boolean(lock ? isExpired(lock) : false);
    const pidAlive = Boolean(lock ? isPidAlive(lock.pid) : false);
    const locked = Boolean(lock && !expired && pidAlive);
    const heldByPid = Boolean(lock && lock.pid === process.pid && locked);

    const described = describePoolStatus({ existing, lock, expired, pidAlive, locked });
    let reason: PoolStatus["reason"] = described.reason;

    const heldByThisProcess = held.has(upstreamId) || heldByPid;
    if (heldByThisProcess) reason = "held_by_this_process";

    out.push({
      upstreamId,
      lockPath: p,
      locked,
      heldByThisProcess,
      availableForThisProcess: !locked || heldByThisProcess,
      lock: lock
        ? {
            pid: lock.pid,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
            pidAlive,
            expired,
          }
        : undefined,
      reason,
      ...(described.note ? { note: described.note } : {}),
    });
  }
  return out;
}
