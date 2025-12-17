import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = any;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
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

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as any });
  const first = (res as any)?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) };
}

async function agentRun(agentId: string, env: Record<string, string>, gatewayExe: string) {
  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: `pool-test-${agentId}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const session = await callText(client, "playwright_pool.session.start", { ttlSeconds: 180 });
  if (!session.json?.ok) {
    await client.close();
    die(`[${agentId}] session.start failed: ${session.text}`);
  }
  const upstreamId = String(session.json.upstreamId);
  const sessionId = String(session.json.sessionId);

  const url = agentId === "A" ? "https://example.com/" : "https://example.org/";
  const nav = await callText(client, "playwright_pool.session.call", {
    sessionId,
    tool: "browser_navigate",
    arguments: { url },
  });
  if (!nav.text) {
    await client.close();
    die(`[${agentId}] navigate returned empty output`);
  }

  const snap = await callText(client, "playwright_pool.session.call", {
    sessionId,
    tool: "browser_snapshot",
    arguments: {},
  });
  if (!snap.text) {
    await client.close();
    die(`[${agentId}] snapshot returned empty output`);
  }

  const end = await callText(client, "playwright_pool.session.end", { sessionId });
  if (!end.json?.ok) {
    await client.close();
    die(`[${agentId}] session.end failed: ${end.text}`);
  }

  await client.close();
  return { agentId, upstreamId };
}

async function main() {
  const bunx = await which("bunx");
  if (!bunx) die("Missing `bunx` on PATH. Install Bun, then retry.");

  const gatewayExe = path.join(import.meta.dir, "..", "dist", "mcpmanager-gateway");
  await buildGatewayIfMissing(gatewayExe);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpmanager-pw-pool-"));
  const registryPath = path.join(tmp, "registry.json");

  const registry = {
    version: 1,
    upstreams: [
      {
        id: "pw1",
        enabled: true,
        command: "bunx",
        args: ["-y", "@playwright/mcp@latest"],
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
        args: ["-y", "@playwright/mcp@latest"],
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
    MCPMANAGER_REGISTRY_PATH: registryPath,
    MCPMANAGER_PLAYWRIGHT_POOL: "pw1,pw2",
  };

  console.log("Running 2 parallel agents against a 2-slot Playwright pool...");
  console.log(`- temp HOME: ${tmp}`);
  console.log(`- registry: ${registryPath}`);

  const [a, b] = await Promise.all([agentRun("A", env, gatewayExe), agentRun("B", env, gatewayExe)]);
  if (a.upstreamId === b.upstreamId) die(`Expected different upstreamIds, got ${a.upstreamId}`);

  console.log("OK");
  console.log(`- agent A reserved: ${a.upstreamId}`);
  console.log(`- agent B reserved: ${b.upstreamId}`);
  console.log("Note: first run may download Playwright + browsers via npx.");
}

await main();
