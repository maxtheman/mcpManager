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
  // Always rebuild for tests so the binary matches the current workspace.
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

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as any });
  const first = (res as any)?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) };
}

async function main() {
  const bunx = await which("bunx");
  if (!bunx) die("Missing `bunx` on PATH. Install Bun, then retry.");

  const gatewayExe = path.join(import.meta.dir, "..", "dist", "Mx-gateway");
  await buildGatewayIfMissing(gatewayExe);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mx-pw-scale-"));
  const registryPath = path.join(tmp, "registry.json");
  const stateDir = path.join(tmp, ".Mx", "state");
  await fs.mkdir(stateDir, { recursive: true });

  const registry = {
    version: 1,
    upstreams: [
      {
        id: "playwright",
        enabled: true,
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless"],
        env: {},
        env_vars: [],
      },
    ],
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const env = {
    ...filterEnv(process.env),
    HOME: tmp,
    MX_REGISTRY_PATH: registryPath,
  };

  const transport = new StdioClientTransport({ command: gatewayExe, env });
  const client = new Client({ name: "pool-scale-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const dry = await callText(client, "playwright_pool_scale", { count: 3, dry_run: true });
  if (!dry.json?.ok) die(`dry run failed: ${dry.text}`);
  if ((dry.json.created ?? []).length !== 3) die(`expected 3 creates in dry run, got: ${dry.text}`);

  const apply = await callText(client, "playwright_pool_scale", { count: 3 });
  if (!apply.json?.ok) die(`apply failed: ${apply.text}`);

  const reg1 = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const ids1 = new Set((reg1.upstreams ?? []).map((u: any) => String(u.id)));
  for (const id of ["playwright1", "playwright2", "playwright3"]) {
    if (!ids1.has(id)) die(`missing clone ${id} after scale up`);
  }

  const down = await callText(client, "playwright_pool_scale", { count: 1, prune: false });
  if (!down.json?.ok) die(`scale down failed: ${down.text}`);
  const reg2 = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const byId2 = new Map<string, any>((reg2.upstreams ?? []).map((u: any) => [String(u.id), u]));
  if (byId2.get("playwright2")?.enabled !== false) die("expected playwright2 disabled on scale down");
  if (byId2.get("playwright3")?.enabled !== false) die("expected playwright3 disabled on scale down");

  const prune = await callText(client, "playwright_pool_scale", { count: 0, prune: true });
  if (!prune.json?.ok) die(`prune failed: ${prune.text}`);
  const reg3 = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const ids3 = new Set((reg3.upstreams ?? []).map((u: any) => String(u.id)));
  for (const id of ["playwright1", "playwright2", "playwright3"]) {
    if (ids3.has(id)) die(`expected ${id} removed after prune`);
  }

  await client.close();
  console.log("OK");
  console.log(`- registry: ${registryPath}`);
  console.log(`- tmp HOME: ${tmp}`);
}

await main();
