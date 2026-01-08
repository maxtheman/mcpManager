import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = any;

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function log(agentId: string, message: string) {
  console.log(`[${agentId}] ${message}`);
}

async function which(cmd: string): Promise<string | null> {
  const proc = Bun.spawn(["/usr/bin/env", "sh", "-lc", `command -v ${cmd}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out : null;
}

async function buildGatewayIfMissing(gatewayExe: string) {
  if (existsSync(gatewayExe)) return;
  const proc = Bun.spawn(["bun", "run", "build:exe"], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) die("Failed to build gateway (bun run build:exe).");
  if (!existsSync(gatewayExe)) die(`Gateway binary missing at ${gatewayExe}`);
}

function parseJsonText(contentText: string): Json {
  try {
    return JSON.parse(contentText);
  } catch {
    return { raw: contentText };
  }
}

type Barrier = {
  ready: () => void;
  waitForAll: () => Promise<void>;
  waitForRelease: () => Promise<void>;
  release: () => void;
};

function createBarrier(count: number): Barrier {
  let readyCount = 0;
  let resolveReady: (() => void) | null = null;
  let resolveRelease: (() => void) | null = null;
  const allReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  return {
    ready: () => {
      readyCount += 1;
      if (readyCount >= count) resolveReady?.();
    },
    waitForAll: () => allReady,
    waitForRelease: () => released,
    release: () => resolveRelease?.(),
  };
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as any });
  const first = (res as any)?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) };
}

async function agentRun(
  agentId: string,
  env: Record<string, string>,
  gatewayExe: string,
  barrier: Barrier,
) {
  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...filterEnv(process.env), ...env },
  });
  const client = new Client({ name: `pool-test-${agentId}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  log(agentId, "connected");

  const session = await callText(client, "playwright_pool_session_start", { ttlSeconds: 180 });
  if (!session.json?.ok) {
    await client.close();
    die(`[${agentId}] session.start failed: ${session.text}`);
  }
  const upstreamId = String(session.json.upstreamId);
  const sessionId = String(session.json.sessionId);
  const tabIndex = Number(session.json.tabIndex ?? -1);
  log(agentId, `session.start ok (upstream=${upstreamId}, tab=${tabIndex})`);

  barrier.ready();
  await barrier.waitForRelease();

  const url = agentId === "A" ? "https://example.com/" : "https://example.org/";
  log(agentId, `navigate ${url}`);
  const nav = await callText(client, "playwright_pool_session_call", {
    sessionId,
    tool: "browser_navigate",
    arguments: { url },
  });
  if (!nav.text) {
    await client.close();
    die(`[${agentId}] navigate returned empty output`);
  }

  log(agentId, "snapshot");
  const snap = await callText(client, "playwright_pool_session_call", {
    sessionId,
    tool: "browser_snapshot",
    arguments: {},
  });
  if (!snap.text) {
    await client.close();
    die(`[${agentId}] snapshot returned empty output`);
  }
  log(agentId, `snapshot bytes=${snap.text.length}`);

  const end = await callText(client, "playwright_pool_session_end", { sessionId });
  if (!end.json?.ok) {
    await client.close();
    die(`[${agentId}] session.end failed: ${end.text}`);
  }
  log(agentId, "session.end ok");

  await client.close();
  log(agentId, "closed");
  return { agentId, upstreamId };
}

async function probeReserve(env: Record<string, string>, gatewayExe: string) {
  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...filterEnv(process.env), ...env },
  });
  const client = new Client({ name: "pool-test-probe", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const res = await callText(client, "playwright_pool_reserve", { ttlSeconds: 60 });
  if (res.json?.ok && res.json?.upstreamId) {
    await callText(client, "playwright_pool_release", { upstreamId: res.json.upstreamId });
  }
  await client.close();
  return res;
}

async function main() {
  const bunx = await which("bunx");
  if (!bunx) die("Missing `bunx` on PATH. Install Bun, then retry.");

  const gatewayExe = path.join(import.meta.dir, "..", "dist", "Mx-gateway");
  await buildGatewayIfMissing(gatewayExe);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mx-pw-pool-"));
  const registryPath = path.join(tmp, "registry.json");

  const headed = isTruthy(process.env.MX_PLAYWRIGHT_HEADED) || process.env.MX_PLAYWRIGHT_HEADLESS === "0";
  const commonArgs = ["-y", "@playwright/mcp@latest", "--isolated"];
  if (!headed) commonArgs.push("--headless");
  if (headed) console.log("Headed mode enabled (MX_PLAYWRIGHT_HEADED=1).");

  const registry = {
    version: 1,
    upstreams: [
      {
        id: "pw1",
        enabled: true,
        command: "bunx",
        args: commonArgs,
        env: {
          // Avoid npx cache races between parallel servers.
          NPM_CONFIG_CACHE: path.join(tmp, "npm-cache", "pw1"),
          npm_config_cache: path.join(tmp, "npm-cache", "pw1"),
          // Keep browser downloads out of the user's global cache.
          PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, "ms-playwright"),
        },
        env_vars: [],
      },
      {
        id: "pw2",
        enabled: true,
        command: "bunx",
        args: commonArgs,
        env: {
          NPM_CONFIG_CACHE: path.join(tmp, "npm-cache", "pw2"),
          npm_config_cache: path.join(tmp, "npm-cache", "pw2"),
          PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, "ms-playwright"),
        },
        env_vars: [],
      },
    ],
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const env = {
    HOME: tmp,
    MX_REGISTRY_PATH: registryPath,
    MX_PLAYWRIGHT_POOL: "pw1,pw2",
  };

  console.log("Running 2 parallel agents against a 2-slot Playwright pool...");
  console.log(`- temp HOME: ${tmp}`);
  console.log(`- registry: ${registryPath}`);
  console.log(`- headless: ${!headed}`);

  const barrier = createBarrier(2);
  const runA = agentRun("A", env, gatewayExe, barrier);
  const runB = agentRun("B", env, gatewayExe, barrier);

  await barrier.waitForAll();
  console.log("[probe] both sessions started; attempting reserve (should fail)");
  const probe = await probeReserve(env, gatewayExe);
  if (probe.json?.ok !== false) {
    die(`Expected reserve to fail while both slots are held, got: ${probe.text}`);
  }
  console.log("[probe] reserve failed as expected");

  barrier.release();
  const [a, b] = await Promise.all([runA, runB]);
  if (a.upstreamId === b.upstreamId) die(`Expected different upstreamIds, got ${a.upstreamId}`);
  const pool = new Set(["pw1", "pw2"]);
  if (!pool.has(a.upstreamId) || !pool.has(b.upstreamId)) {
    die(`Expected upstreams in {pw1,pw2}, got ${a.upstreamId}, ${b.upstreamId}`);
  }

  console.log("OK");
  console.log(`- agent A reserved: ${a.upstreamId}`);
  console.log(`- agent B reserved: ${b.upstreamId}`);
  console.log("Note: first run may download Playwright + browsers via npx.");
}

await main();
