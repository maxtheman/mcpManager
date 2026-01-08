import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PersistedPoolSession = {
  upstreamId: string;
  tabIndexHint?: number;
  tabFingerprint?: string;
  updatedAt: string;
};

type PoolSessionStateFile = {
  version: 1 | 2;
  sessions: Record<string, PersistedPoolSession>;
};

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function stateDir(): string {
  return path.join(homeDir(), ".Mx", "state");
}

function poolSessionStatePath(): string {
  return path.join(stateDir(), "playwright-pool-sessions.json");
}

async function readStateFile(filePath: string): Promise<PoolSessionStateFile> {
  if (!existsSync(filePath)) return { version: 2, sessions: {} };
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (typeof raw?.sessions !== "object" || raw.sessions === null) {
    return { version: 2, sessions: {} };
  }
  if (raw?.version === 2) return raw as PoolSessionStateFile;

  // Back-compat (v1): { upstreamId, tabIndex }.
  if (raw?.version === 1) {
    const sessions: Record<string, PersistedPoolSession> = {};
    for (const [k, v] of Object.entries(raw.sessions as Record<string, any>)) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.upstreamId !== "string") continue;
      const tabIndex = typeof v.tabIndex === "number" ? v.tabIndex : undefined;
      sessions[k] = {
        upstreamId: v.upstreamId,
        tabIndexHint: tabIndex,
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : new Date().toISOString(),
      };
    }
    return { version: 2, sessions };
  }

  return { version: 2, sessions: {} };
}

async function writeStateFile(filePath: string, state: PoolSessionStateFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

export async function loadPoolSessionMapping(): Promise<Record<string, PersistedPoolSession>> {
  const filePath = poolSessionStatePath();
  try {
    const state = await readStateFile(filePath);
    return state.sessions ?? {};
  } catch {
    return {};
  }
}

export async function savePoolSessionMapping(
  sessionKey: string,
  value: { upstreamId: string; tabIndexHint?: number; tabFingerprint?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const filePath = poolSessionStatePath();
  try {
    const state = await readStateFile(filePath);
    state.sessions[sessionKey] = {
      upstreamId: value.upstreamId,
      ...(typeof value.tabIndexHint === "number" ? { tabIndexHint: value.tabIndexHint } : {}),
      ...(typeof value.tabFingerprint === "string" && value.tabFingerprint.trim().length > 0
        ? { tabFingerprint: value.tabFingerprint }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    state.version = 2;
    await writeStateFile(filePath, state);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePoolSessionMapping(
  sessionKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const filePath = poolSessionStatePath();
  try {
    const state = await readStateFile(filePath);
    delete state.sessions[sessionKey];
    await writeStateFile(filePath, state);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
