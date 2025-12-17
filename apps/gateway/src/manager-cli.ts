import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readRegistry, writeRegistry, type Upstream } from "./registry/registry.js";

type Cmd =
  | "doctor"
  | "install"
  | "status"
  | "help"
  | "build-gateway"
  | "centralize"
  | "decentralize";

const argsSchema = z.object({
  cmd: z.enum(["doctor", "install", "status", "help", "build-gateway", "centralize", "decentralize"]),
  fix: z.boolean().default(false),
  apply: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

function parseArgs(argv: string[]): z.infer<typeof argsSchema> {
  const cmd = (argv[2] as Cmd | undefined) ?? "help";
  const fix = argv.includes("--fix");
  const apply = argv.includes("--apply");
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  return argsSchema.parse({ cmd, fix, apply, verbose });
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function gatewayInstallPath(): string {
  return path.join(homeDir(), ".mcpmanager", "bin", "mcpmanager-gateway");
}

function gatewayBuiltPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "dist", "mcpmanager-gateway");
}

function codexConfigPath(): string {
  return path.join(homeDir(), ".codex", "config.toml");
}

function claudeDesktopConfigPath(): string {
  // macOS only for now.
  return path.join(
    homeDir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

function backupPath(original: string): string {
  return `${original}.bak.${Math.floor(Date.now() / 1000)}`;
}

async function writeFileWithBackup(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    await fs.copyFile(filePath, backupPath(filePath));
  }
  await fs.writeFile(filePath, contents, "utf8");
}

async function run(cmd: string, cmdArgs: string[], cwd?: string) {
  const proc = Bun.spawn([cmd, ...cmdArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function buildGateway(verbose: boolean) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gatewayDir = path.join(here, "..");
  const { stdout, stderr, exitCode } = await run("bun", ["run", "build:exe"], gatewayDir);
  if (verbose) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  if (exitCode !== 0) throw new Error("Failed to build gateway (bun run build:exe).");
  if (!existsSync(gatewayBuiltPath())) throw new Error("Gateway binary missing after build.");
}

async function installGatewayBinary() {
  const src = gatewayBuiltPath();
  if (!existsSync(src)) {
    throw new Error(`Gateway binary not found at ${src}. Run: bun run build:exe`);
  }
  const dest = gatewayInstallPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  try {
    chmodSync(dest, 0o755);
  } catch {
    // ignore on non-unix
  }
  return dest;
}

function tomlString(value: string): string {
  // Minimal TOML string escaping for our use-case.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function renderCodexMcpManagerSection(gatewayPath: string) {
  const env: Record<string, string> = {};
  for (const key of [
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "DAYTONA_SERVER_URL",
    "DAYTONA_TARGET",
    "TAILSCALE_API_KEY",
    "TAILSCALE_TAILNET",
    "MCPMANAGER_REGISTRY_PATH",
    "MCPMANAGER_POLICY_MODE",
    "MCPMANAGER_TAILSCALE_ALLOW_KEYS",
    "MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS",
    "MCPMANAGER_TAILSCALE_ALLOW_REUSABLE",
    "MCPMANAGER_TAILSCALE_TAILNET_LOCK",
    "MCPMANAGER_TAILSCALE_TAGS_ALLOW",
    "MCPMANAGER_PLAYWRIGHT_POOL",
  ] as const) {
    const v = process.env[key];
    if (v && v.length > 0) env[key] = v;
  }

  const envInline =
    Object.keys(env).length > 0
      ? `env = { ${Object.entries(env)
          .map(([k, v]) => `${k} = ${tomlString(v)}`)
          .join(", ")} }`
      : null;

  const envVars = [
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "DAYTONA_SERVER_URL",
    "DAYTONA_TARGET",
    "TAILSCALE_API_KEY",
    "TAILSCALE_TAILNET",
    "MCPMANAGER_REGISTRY_PATH",
    "MCPMANAGER_POLICY_MODE",
    "MCPMANAGER_TAILSCALE_ALLOW_KEYS",
    "MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS",
    "MCPMANAGER_TAILSCALE_ALLOW_REUSABLE",
    "MCPMANAGER_TAILSCALE_TAILNET_LOCK",
    "MCPMANAGER_TAILSCALE_TAGS_ALLOW",
    "MCPMANAGER_PLAYWRIGHT_POOL",
  ];

  return (
    [
      "[mcp_servers.mcpmanager]",
      `command = ${tomlString(gatewayPath)}`,
      "args = []",
      "enabled = true",
      envInline,
      "env_vars = [",
      ...envVars.map((v) => `  ${tomlString(v)},`),
      "]",
      "",
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

function upsertTomlTable(text: string, tableHeader: string, replacement: string): string {
  const headerRe = new RegExp(`^\\[${tableHeader.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*$`, "m");
  const match = headerRe.exec(text);
  if (!match) {
    const prefix = text.trimEnd().length === 0 ? "" : "\n\n";
    return text.replace(/\s*$/, "") + prefix + replacement;
  }

  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextHeaderRe = /^\[.+\]\s*$/gm;
  nextHeaderRe.lastIndex = afterHeader;
  const next = nextHeaderRe.exec(text);
  const end = next ? next.index : text.length;

  const before = text.slice(0, start).replace(/\s*$/, "");
  const after = text.slice(end).replace(/^\s*/, "");
  const joinerBefore = before.length === 0 ? "" : "\n\n";
  const joinerAfter = after.length === 0 ? "" : "\n\n";
  return before + joinerBefore + replacement.replace(/\s*$/, "\n") + joinerAfter + after;
}

async function installCodexConfig(gatewayPath: string) {
  const filePath = codexConfigPath();
  const current = existsSync(filePath) ? await fs.readFile(filePath, "utf8") : "";
  const section = renderCodexMcpManagerSection(gatewayPath);
  const next = upsertTomlTable(current, "mcp_servers.mcpmanager", section);
  await writeFileWithBackup(filePath, next);
  return filePath;
}

function removeTomlTable(text: string, tableHeader: string): string {
  const headerRe = new RegExp(
    `^\\[${tableHeader.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*$`,
    "m",
  );
  const match = headerRe.exec(text);
  if (!match) return text;

  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextHeaderRe = /^\[.+\]\s*$/gm;
  nextHeaderRe.lastIndex = afterHeader;
  const next = nextHeaderRe.exec(text);
  const end = next ? next.index : text.length;

  const before = text.slice(0, start).replace(/\s*$/, "");
  const after = text.slice(end).replace(/^\s*/, "");
  if (!before && !after) return "";
  if (!before) return after;
  if (!after) return before + "\n";
  return before + "\n\n" + after;
}

function setTomlEnabledInTable(text: string, tableHeader: string, enabled: boolean): string {
  const headerRe = new RegExp(`^\\[${tableHeader.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*$`, "m");
  const match = headerRe.exec(text);
  if (!match) return text;

  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextHeaderRe = /^\[.+\]\s*$/gm;
  nextHeaderRe.lastIndex = afterHeader;
  const next = nextHeaderRe.exec(text);
  const end = next ? next.index : text.length;

  const block = text.slice(start, end);
  const lines = block.split("\n");
  const enabledLine = `enabled = ${enabled ? "true" : "false"}`;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*enabled\s*=/.test(lines[i] ?? "")) {
      lines[i] = enabledLine;
      found = true;
      break;
    }
  }
  if (!found) {
    lines.splice(1, 0, enabledLine);
  }

  const nextBlock = lines.join("\n");
  return text.slice(0, start) + nextBlock + text.slice(end);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function splitCommandLine(commandLine: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        const next = commandLine[i + 1];
        if (next) {
          cur += next;
          i++;
          continue;
        }
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as any;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    if (ch === "\\") {
      const next = commandLine[i + 1];
      if (next) {
        cur += next;
        i++;
        continue;
      }
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

async function importUpstreamsFromCodex(): Promise<Upstream[]> {
  const p = codexConfigPath();
  if (!existsSync(p)) return [];
  const text = await fs.readFile(p, "utf8");
  let doc: any = {};
  try {
    doc = Bun.TOML.parse(text) as any;
  } catch {
    return [];
  }
  const servers: any = doc?.mcp_servers ?? {};
  if (!servers || typeof servers !== "object") return [];

  const upstreams: Upstream[] = [];
  for (const [id, cfg] of Object.entries(servers)) {
    if (id === "mcpmanager") continue;
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as any;
    if (typeof c.command !== "string") continue;
    upstreams.push({
      id,
      enabled: c.enabled !== false,
      command: c.command,
      args: normalizeStringArray(c.args),
      env: normalizeStringMap(c.env),
      env_vars: normalizeStringArray(c.env_vars),
    });
  }
  return upstreams;
}

async function importUpstreamsFromClaudeDesktop(): Promise<Upstream[]> {
  const p = claudeDesktopConfigPath();
  if (!existsSync(p)) return [];
  let doc: any = {};
  try {
    doc = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return [];
  }
  const servers: any = doc?.mcpServers ?? {};
  if (!servers || typeof servers !== "object") return [];

  const upstreams: Upstream[] = [];
  for (const [id, cfg] of Object.entries(servers)) {
    if (id === "mcpmanager") continue;
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as any;
    if (typeof c.command !== "string") continue;
    const env = normalizeStringMap(c.env);
    const env_vars: string[] = [];
    const explicitEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v === `\${${k}}`) env_vars.push(k);
      else explicitEnv[k] = v;
    }
    upstreams.push({
      id,
      enabled: true,
      command: c.command,
      args: normalizeStringArray(c.args),
      env: explicitEnv,
      env_vars,
    });
  }
  return upstreams;
}

async function importUpstreamsFromClaudeCodeList(): Promise<Upstream[]> {
  const { exitCode } = await run("claude", ["--version"]);
  if (exitCode !== 0) return [];

  const list = await run("claude", ["mcp", "list"]);
  const upstreams: Upstream[] = [];

  for (const line of (list.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Example: exa: npx -y exa-mcp-server - ✓ Connected
    const m = /^([A-Za-z0-9._-]+):\s+(.+?)\s+-\s+/.exec(trimmed);
    if (!m) continue;
    const id = m[1]!;
    const commandLine = m[2]!;
    if (id === "mcpmanager") continue;
    const parts = splitCommandLine(commandLine);
    if (parts.length === 0) continue;
    upstreams.push({
      id,
      enabled: true,
      command: parts[0]!,
      args: parts.slice(1),
      env: {},
      env_vars: [],
    });
  }

  return upstreams;
}

async function centralize({ apply, verbose }: { apply: boolean; verbose: boolean }) {
  const fromCodex = await importUpstreamsFromCodex();
  const fromDesktop = await importUpstreamsFromClaudeDesktop();
  const fromClaudeCode = await importUpstreamsFromClaudeCodeList();

  // Merge by id, preferring Codex definitions.
  const byId = new Map<string, Upstream>();
  for (const u of fromClaudeCode) byId.set(u.id, u);
  for (const u of fromDesktop) byId.set(u.id, u);
  for (const u of fromCodex) byId.set(u.id, u);

  const reg = await readRegistry();
  const existing = new Map(reg.upstreams.map((u) => [u.id, u] as const));
  for (const [id, u] of byId.entries()) {
    existing.set(id, u);
  }

  const next = { version: 1 as const, upstreams: Array.from(existing.values()).sort((a, b) => a.id.localeCompare(b.id)) };
  await writeRegistry(next);

  const ids = Array.from(byId.keys()).sort();

  let codexUpdated: string | null = null;
  let desktopUpdated: string | null = null;
  let claudeRemoved: Array<{ name: string; ok: boolean; reason?: string }> = [];

  if (apply) {
    // Codex: disable direct MCP servers now routed via mcpmanager.
    const codexPath = codexConfigPath();
    if (existsSync(codexPath)) {
      let text = await fs.readFile(codexPath, "utf8");
      for (const id of ids) {
        text = setTomlEnabledInTable(text, `mcp_servers.${id}`, false);
      }
      await writeFileWithBackup(codexPath, text);
      codexUpdated = codexPath;
    }

    // Claude Desktop: remove other servers, stash under mcpServersDisabled.
    const desktopPath = claudeDesktopConfigPath();
    if (existsSync(desktopPath)) {
      const doc = JSON.parse(await fs.readFile(desktopPath, "utf8"));
      if (!doc.mcpServers) doc.mcpServers = {};
      if (!doc.mcpServersDisabled) doc.mcpServersDisabled = {};
      for (const id of ids) {
        if (doc.mcpServers?.[id]) {
          doc.mcpServersDisabled[id] = doc.mcpServers[id];
          delete doc.mcpServers[id];
        }
      }
      await writeFileWithBackup(desktopPath, JSON.stringify(doc, null, 2) + "\n");
      desktopUpdated = desktopPath;
    }

    // Claude Code: remove user-scoped direct servers (if present), since they're now routed.
    const { exitCode } = await run("claude", ["--version"]);
    if (exitCode === 0) {
      const list = await run("claude", ["mcp", "list"]);
      const names = (list.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .map((l) => /^([A-Za-z0-9._-]+):\s+/.exec(l)?.[1])
        .filter((v): v is string => Boolean(v))
        .filter((n) => n !== "mcpmanager");
      for (const name of names) {
        // Only remove if we imported it (or it conflicts by id).
        if (!ids.includes(name)) continue;
        const res = await run("claude", ["mcp", "remove", "--scope", "user", name]);
        claudeRemoved.push({
          name,
          ok: res.exitCode === 0,
          reason: res.exitCode === 0 ? undefined : (res.stderr || res.stdout).trim(),
        });
        if (verbose && res.exitCode !== 0) {
          process.stderr.write(res.stderr);
        }
      }
    }
  }

  return { imported: ids, registryPath: process.env.MCPMANAGER_REGISTRY_PATH ?? "(default)", apply, codexUpdated, desktopUpdated, claudeRemoved };
}

function renderClaudeDesktopServer(u: Upstream) {
  const env: Record<string, string> = {};
  for (const k of u.env_vars ?? []) env[k] = `\${${k}}`;
  for (const [k, v] of Object.entries(u.env ?? {})) env[k] = v;
  return { command: u.command, args: u.args ?? [], env };
}

async function decentralize({ apply, verbose }: { apply: boolean; verbose: boolean }) {
  const reg = await readRegistry();
  const enabledUpstreams = reg.upstreams.filter((u) => u.enabled).filter((u) => u.id !== "mcpmanager");

  let codexUpdated: string | null = null;
  let desktopUpdated: string | null = null;
  let claudeUpdated: Array<{ name: string; action: string; ok: boolean; reason?: string }> = [];

  if (apply) {
    // Codex: remove mcpmanager and re-enable upstreams.
    const codexPath = codexConfigPath();
    if (existsSync(codexPath)) {
      let text = await fs.readFile(codexPath, "utf8");
      text = removeTomlTable(text, "mcp_servers.mcpmanager");
      for (const u of enabledUpstreams) {
        // best-effort: enable existing tables; don't add new ones here.
        text = setTomlEnabledInTable(text, `mcp_servers.${u.id}`, true);
      }
      await writeFileWithBackup(codexPath, text);
      codexUpdated = codexPath;
    }

    // Claude Desktop: remove mcpmanager and restore upstreams.
    const desktopPath = claudeDesktopConfigPath();
    if (existsSync(desktopPath)) {
      const doc = JSON.parse(await fs.readFile(desktopPath, "utf8"));
      if (!doc.mcpServers) doc.mcpServers = {};
      delete doc.mcpServers.mcpmanager;
      for (const u of enabledUpstreams) {
        doc.mcpServers[u.id] = renderClaudeDesktopServer(u);
      }
      await writeFileWithBackup(desktopPath, JSON.stringify(doc, null, 2) + "\n");
      desktopUpdated = desktopPath;
    }

    // Claude Code: remove mcpmanager and restore upstreams.
    const { exitCode } = await run("claude", ["--version"]);
    if (exitCode === 0) {
      const rm = await run("claude", ["mcp", "remove", "--scope", "user", "mcpmanager"]);
      claudeUpdated.push({
        name: "mcpmanager",
        action: "remove",
        ok: rm.exitCode === 0 || /not found/i.test(rm.stderr) || /does not exist/i.test(rm.stderr),
        reason: rm.exitCode === 0 ? undefined : (rm.stderr || rm.stdout).trim(),
      });

      for (const u of enabledUpstreams) {
        const cfg: any = { command: u.command, args: u.args ?? [] };
        if (u.env_vars?.length || Object.keys(u.env ?? {}).length) {
          const env: Record<string, string> = {};
          for (const k of u.env_vars ?? []) env[k] = `\${${k}}`;
          for (const [k, v] of Object.entries(u.env ?? {})) env[k] = v;
          cfg.env = env;
        }
        const res = await run("claude", ["mcp", "add-json", u.id, "--scope", "user", JSON.stringify(cfg)]);
        const stderr = (res.stderr || "").trim();
        const ok = res.exitCode === 0 || /already exists/i.test(stderr);
        claudeUpdated.push({
          name: u.id,
          action: "add-json",
          ok,
          reason: ok ? undefined : stderr || (res.stdout || "").trim(),
        });
        if (verbose && !ok) process.stderr.write(res.stderr);
      }
    }
  }

  return {
    restored: enabledUpstreams.map((u) => u.id),
    apply,
    codexUpdated,
    desktopUpdated,
    claudeUpdated,
    note: "Restart Codex/Claude apps after config changes.",
  };
}

async function installClaudeDesktopConfig(gatewayPath: string) {
  const filePath = claudeDesktopConfigPath();
  let doc: any = {};
  if (existsSync(filePath)) {
    doc = JSON.parse(await fs.readFile(filePath, "utf8"));
  }
  if (!doc.mcpServers) doc.mcpServers = {};
  const envValue = (key: string) => {
    const v = process.env[key];
    return v && v.length > 0 ? v : `\${${key}}`;
  };
  doc.mcpServers.mcpmanager = {
    command: gatewayPath,
    args: [],
    env: {
      DAYTONA_API_KEY: envValue("DAYTONA_API_KEY"),
      DAYTONA_API_URL: envValue("DAYTONA_API_URL"),
      DAYTONA_SERVER_URL: envValue("DAYTONA_SERVER_URL"),
      DAYTONA_TARGET: envValue("DAYTONA_TARGET"),
      TAILSCALE_API_KEY: envValue("TAILSCALE_API_KEY"),
      TAILSCALE_TAILNET: envValue("TAILSCALE_TAILNET"),
      MCPMANAGER_REGISTRY_PATH: envValue("MCPMANAGER_REGISTRY_PATH"),
      MCPMANAGER_POLICY_MODE: envValue("MCPMANAGER_POLICY_MODE"),
      MCPMANAGER_TAILSCALE_ALLOW_KEYS: envValue("MCPMANAGER_TAILSCALE_ALLOW_KEYS"),
      MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS: envValue("MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS"),
      MCPMANAGER_TAILSCALE_ALLOW_REUSABLE: envValue("MCPMANAGER_TAILSCALE_ALLOW_REUSABLE"),
      MCPMANAGER_TAILSCALE_TAILNET_LOCK: envValue("MCPMANAGER_TAILSCALE_TAILNET_LOCK"),
      MCPMANAGER_TAILSCALE_TAGS_ALLOW: envValue("MCPMANAGER_TAILSCALE_TAGS_ALLOW"),
    },
  };
  await writeFileWithBackup(filePath, JSON.stringify(doc, null, 2) + "\n");
  return filePath;
}

async function installClaudeCodeConfig(gatewayPath: string) {
  const { exitCode } = await run("claude", ["--version"]);
  if (exitCode !== 0) return { ok: false, reason: "claude CLI not found" };

  const config = JSON.stringify({ command: gatewayPath, args: [] });
  const res = await run("claude", ["mcp", "add-json", "mcpmanager", "--scope", "user", config]);
  if (res.exitCode !== 0) {
    const err = res.stderr.trim() || "claude mcp add-json failed";
    if (/already exists/i.test(err)) return { ok: true, reason: err };
    return { ok: false, reason: err };
  }
  return { ok: true, reason: res.stdout.trim() };
}

async function smokePingGateway(gatewayPath: string) {
  const transport = new StdioClientTransport({ command: gatewayPath });
  const client = new Client({ name: "mcpmanager-doctor", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  const ping = await client.callTool({ name: "health.ping", arguments: {} });
  await client.close();
  const first = (ping as any)?.content?.[0];
  return {
    tools: tools.tools?.map((t) => t.name) ?? [],
    pingText: typeof first?.text === "string" ? first.text : "",
  };
}

async function status() {
  const gwInstalled = gatewayInstallPath();
  const gwExists = existsSync(gwInstalled);
  const codex = codexConfigPath();
  const claudeDesktop = claudeDesktopConfigPath();

  const codexInstalled = await (async () => {
    if (!existsSync(codex)) return false;
    try {
      const text = await Bun.file(codex).text();
      return /^\[mcp_servers\.mcpmanager\]\s*$/m.test(text);
    } catch {
      return false;
    }
  })();

  const claudeDesktopInstalled = await (async () => {
    if (!existsSync(claudeDesktop)) return false;
    try {
      const doc = JSON.parse(await Bun.file(claudeDesktop).text());
      return Boolean(doc?.mcpServers?.mcpmanager);
    } catch {
      return false;
    }
  })();

  return {
    gateway: { path: gwInstalled, exists: gwExists },
    codex: { path: codex, exists: existsSync(codex), installed: codexInstalled },
    claudeDesktop: {
      path: claudeDesktop,
      exists: existsSync(claudeDesktop),
      installed: claudeDesktopInstalled,
    },
  };
}

function printHelp() {
  console.log(
    [
      "mcpManager (dev CLI)",
      "",
      "Usage:",
      "  bun run manager help",
      "  bun run manager status",
      "  bun run manager build-gateway",
      "  bun run manager install",
      "  bun run manager doctor [--fix]",
      "  bun run manager centralize [--apply]",
      "  bun run manager decentralize --apply",
      "",
      "Flags:",
      "  --fix       Run install steps during doctor",
      "  --apply     Apply config changes (centralize)",
      "  -v,--verbose Show command output",
      "",
      "Environment:",
      "  DAYTONA_API_KEY, DAYTONA_SERVER_URL (or DAYTONA_API_URL), DAYTONA_TARGET",
      "  TAILSCALE_API_KEY, TAILSCALE_TAILNET",
      "  MCPMANAGER_POLICY_MODE, MCPMANAGER_TAILSCALE_ALLOW_KEYS, MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.cmd === "help") {
    printHelp();
    return;
  }

  if (args.cmd === "status") {
    console.log(JSON.stringify(await status(), null, 2));
    return;
  }

  if (args.cmd === "build-gateway") {
    await buildGateway(args.verbose);
    console.log(`Built gateway: ${gatewayBuiltPath()}`);
    return;
  }

  if (args.cmd === "install") {
    await buildGateway(args.verbose);
    const gw = await installGatewayBinary();
    const codex = await installCodexConfig(gw);
    const desktop = await installClaudeDesktopConfig(gw);
    const claude = await installClaudeCodeConfig(gw);
    console.log(
      JSON.stringify(
        {
          gateway: gw,
          codex,
          claudeDesktop: desktop,
          claudeCode: claude,
          note: "Restart Codex/Claude apps after config changes.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.cmd === "doctor") {
    const before = await status();
    if (args.fix) {
      await mainInstall(args.verbose);
    }
    const after = await status();
    const gwPath = gatewayInstallPath();
    const gatewayOk = existsSync(gwPath);
    const ping = gatewayOk ? await smokePingGateway(gwPath) : null;

    console.log(
      JSON.stringify(
        {
          before,
          after,
          gatewayPing: ping,
          env: {
            DAYTONA_API_KEY: Boolean(process.env.DAYTONA_API_KEY),
            DAYTONA_SERVER_URL: Boolean(process.env.DAYTONA_SERVER_URL || process.env.DAYTONA_API_URL),
            DAYTONA_TARGET: process.env.DAYTONA_TARGET ?? null,
            TAILSCALE_API_KEY: Boolean(process.env.TAILSCALE_API_KEY),
            TAILSCALE_TAILNET: process.env.TAILSCALE_TAILNET ?? null,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.cmd === "centralize") {
    const res = await centralize({ apply: args.apply, verbose: args.verbose });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (args.cmd === "decentralize") {
    const res = await decentralize({ apply: args.apply, verbose: args.verbose });
    console.log(JSON.stringify(res, null, 2));
    return;
  }
}

async function mainInstall(verbose: boolean) {
  await buildGateway(verbose);
  const gw = await installGatewayBinary();
  await installCodexConfig(gw);
  await installClaudeDesktopConfig(gw);
  await installClaudeCodeConfig(gw);
}

await main();
