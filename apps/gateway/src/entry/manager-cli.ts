import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readRegistry, writeRegistry, readRegistryFile, registryPath, type Upstream } from "../infra/registry/registry.js";
import { listSourceCommands, type CommandSummary } from "../core/commands/inventory.js";
import { sourceDir } from "../shared/source.js";

type Cmd =
  | "install"
  | "help"
  | "centralize"
  | "decentralize"
  | "instructions";

const argsSchema = z.object({
  cmd: z.enum(["install", "help", "centralize", "decentralize", "instructions"]),
  apply: z.boolean().default(false),
  verbose: z.boolean().default(false),
  repo: z.string().optional(),
  sourceDir: z.string().optional(),
  force: z.boolean().default(false),
});

function parseArgs(argv: string[]): z.infer<typeof argsSchema> {
  const cmd = (argv[2] as Cmd | undefined) ?? "help";
  const apply = argv.includes("--apply");
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const repoFlag = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : undefined;
  const sourceDirFlag = argv.includes("--source-dir") ? argv[argv.indexOf("--source-dir") + 1] : undefined;
  const force = argv.includes("--force");
  return argsSchema.parse({ cmd, apply, verbose, repo: repoFlag, sourceDir: sourceDirFlag, force });
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function legacyBaseDir(): string {
  return path.join(homeDir(), ".mcpmanager");
}

function mxBaseDir(): string {
  return path.join(homeDir(), ".Mx");
}

function gatewayInstallPath(): string {
  return path.join(mxBaseDir(), "bin", "Mx-gateway");
}

function gatewayBuiltPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "dist", "Mx-gateway");
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
  const gatewayDir = path.join(here, "..", "..");
  const { stdout, stderr, exitCode } = await run("bun", ["run", "build:exe"], gatewayDir);
  if (verbose) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  if (exitCode !== 0) throw new Error("Failed to build gateway (bun run build:exe).");
  if (!existsSync(gatewayBuiltPath())) throw new Error("Gateway binary missing after build.");
}

async function migrateLegacyHomeLayout(): Promise<{ migrated: boolean; copied: string[]; skipped: string[]; errors: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const legacy = legacyBaseDir();
  const next = mxBaseDir();
  if (!existsSync(legacy)) return { migrated: false, copied, skipped, errors };

  try {
    await fs.mkdir(next, { recursive: true });
  } catch (e) {
    errors.push(`Failed to create ${next}: ${String(e)}`);
    return { migrated: false, copied, skipped, errors };
  }

  const copyFileIfMissing = async (rel: string) => {
    const from = path.join(legacy, rel);
    const to = path.join(next, rel);
    if (!existsSync(from)) return;
    if (existsSync(to)) {
      skipped.push(rel);
      return;
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      copied.push(rel);
    } catch (e) {
      errors.push(`Failed to copy ${from} -> ${to}: ${String(e)}`);
    }
  };

  const copyDirIfMissing = async (rel: string) => {
    const from = path.join(legacy, rel);
    const to = path.join(next, rel);
    if (!existsSync(from)) return;
    if (existsSync(to)) {
      skipped.push(rel);
      return;
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      // Bun/Node supports fs.cp in modern runtimes; use best-effort.
      await (fs as any).cp(from, to, { recursive: true, errorOnExist: false });
      copied.push(rel);
    } catch (e) {
      errors.push(`Failed to copy dir ${from} -> ${to}: ${String(e)}`);
    }
  };

  await copyFileIfMissing("registry.json");
  await copyDirIfMissing("source");
  await copyDirIfMissing("state");

  const migrated = copied.length > 0;
  return { migrated, copied, skipped, errors };
}

async function installGatewayBinary(): Promise<
  | { ok: true; gatewayPath: string; mode: "installed" }
  | { ok: true; gatewayPath: string; mode: "local"; warning: string }
> {
  const src = gatewayBuiltPath();
  if (!existsSync(src)) {
    throw new Error(`Gateway binary not found at ${src}. Run: bun run build:exe`);
  }
  const dest = gatewayInstallPath();
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    try {
      chmodSync(dest, 0o755);
    } catch {
      // ignore on non-unix
    }
    return { ok: true, gatewayPath: dest, mode: "installed" };
  } catch (e) {
    return {
      ok: true,
      gatewayPath: src,
      mode: "local",
      warning: `Failed to install gateway binary to ${dest}; using local binary at ${src}. Error: ${String(e)}`,
    };
  }
}

function tomlString(value: string): string {
  // Minimal TOML string escaping for our use-case.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function renderCodexMcpManagerSection(gatewayPath: string) {
  const env: Record<string, string> = {};
  for (const key of [
    "MX_REGISTRY_PATH",
    "MX_PLAYWRIGHT_POOL",
    "MX_INTERACTIONS_DIR",
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
    "MX_REGISTRY_PATH",
    "MX_PLAYWRIGHT_POOL",
    "MX_INTERACTIONS_DIR",
  ];

  return (
    [
      "[mcp_servers.Mx]",
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
  const withoutLegacy = removeTomlTable(current, "mcp_servers.mcpmanager");
  const next = upsertTomlTable(withoutLegacy, "mcp_servers.Mx", section);
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
    if (id === "mcpmanager" || id === "Mx") continue;
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
    if (id === "mcpmanager" || id === "Mx") continue;
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
    if (id === "mcpmanager" || id === "Mx") continue;
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
  const claudeRemoved: Array<{ name: string; ok: boolean; reason?: string }> = [];

  if (apply) {
    // Codex: disable direct MCP servers now routed via Mx.
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
        .filter((n) => n !== "mcpmanager" && n !== "Mx");
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

  return { imported: ids, registryPath: process.env.MX_REGISTRY_PATH ?? "(default)", apply, codexUpdated, desktopUpdated, claudeRemoved };
}

function renderClaudeDesktopServer(u: Upstream) {
  const env: Record<string, string> = {};
  for (const k of u.env_vars ?? []) env[k] = `\${${k}}`;
  for (const [k, v] of Object.entries(u.env ?? {})) env[k] = v;
  return { command: u.command, args: u.args ?? [], env };
}

async function decentralize({ apply, verbose }: { apply: boolean; verbose: boolean }) {
  const reg = await readRegistry();
  const enabledUpstreams = reg.upstreams.filter((u) => u.enabled).filter((u) => u.id !== "Mx");

  let codexUpdated: string | null = null;
  let desktopUpdated: string | null = null;
  const claudeUpdated: Array<{ name: string; action: string; ok: boolean; reason?: string }> = [];

  if (apply) {
    // Codex: remove Mx and re-enable upstreams.
    const codexPath = codexConfigPath();
    if (existsSync(codexPath)) {
      let text = await fs.readFile(codexPath, "utf8");
      text = removeTomlTable(text, "mcp_servers.Mx");
      for (const u of enabledUpstreams) {
        // best-effort: enable existing tables; don't add new ones here.
        text = setTomlEnabledInTable(text, `mcp_servers.${u.id}`, true);
      }
      await writeFileWithBackup(codexPath, text);
      codexUpdated = codexPath;
    }

    // Claude Desktop: remove Mx and restore upstreams.
    const desktopPath = claudeDesktopConfigPath();
    if (existsSync(desktopPath)) {
      const doc = JSON.parse(await fs.readFile(desktopPath, "utf8"));
      if (!doc.mcpServers) doc.mcpServers = {};
      delete doc.mcpServers.Mx;
      for (const u of enabledUpstreams) {
        doc.mcpServers[u.id] = renderClaudeDesktopServer(u);
      }
      await writeFileWithBackup(desktopPath, JSON.stringify(doc, null, 2) + "\n");
      desktopUpdated = desktopPath;
    }

    // Claude Code: remove Mx and restore upstreams.
    const { exitCode } = await run("claude", ["--version"]);
    if (exitCode === 0) {
      const rm = await run("claude", ["mcp", "remove", "--scope", "user", "Mx"]);
      claudeUpdated.push({
        name: "Mx",
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
  delete doc.mcpServers.mcpmanager;
  doc.mcpServers.Mx = {
    command: gatewayPath,
    args: [],
    env: {
      MX_REGISTRY_PATH: envValue("MX_REGISTRY_PATH"),
      MX_PLAYWRIGHT_POOL: envValue("MX_PLAYWRIGHT_POOL"),
      MX_INTERACTIONS_DIR: envValue("MX_INTERACTIONS_DIR"),
    },
  };
  await writeFileWithBackup(filePath, JSON.stringify(doc, null, 2) + "\n");
  return filePath;
}

async function installClaudeCodeConfig(gatewayPath: string) {
  const { exitCode } = await run("claude", ["--version"]);
  if (exitCode !== 0) return { ok: false, reason: "claude CLI not found" };

  const config = JSON.stringify({ command: gatewayPath, args: [] });
  // Best-effort: remove legacy name first so `mcp list` stays clean.
  await run("claude", ["mcp", "remove", "--scope", "user", "mcpmanager"]);
  const res = await run("claude", ["mcp", "add-json", "Mx", "--scope", "user", config]);
  if (res.exitCode !== 0) {
    const err = res.stderr.trim() || "claude mcp add-json failed";
    if (/already exists/i.test(err)) return { ok: true, reason: err };
    return { ok: false, reason: err };
  }
  return { ok: true, reason: res.stdout.trim() };
}

function printHelp() {
  console.log(
    [
      "Mx (dev CLI)",
      "",
      "Usage:",
      "  bun run manager help",
      "  bun run manager install",
      "  bun run manager centralize [--apply]",
      "  bun run manager decentralize --apply",
      "  bun run manager instructions [--repo <path>] [--source-dir <path>] [--force]",
      "",
      "Flags:",
      "  --apply     Apply config changes (centralize)",
      "  -v,--verbose Show command output",
      "  --repo      Target repo to write AGENTS.md (default: cwd)",
      "  --source-dir Source root containing registry.json + skills/ (default: MX_SOURCE_DIR or ~/.Mx/source)",
      "  --force     Replace CLAUDE.md if it already exists",
      "",
      "Environment:",
      "  MX_REGISTRY_PATH, MX_SOURCE_DIR, MX_PLAYWRIGHT_POOL, MX_INTERACTIONS_DIR",
    ].join("\n"),
  );
}

type SkillSummary = {
  name: string;
  description: string;
  relativePath: string;
};

function parseFrontmatter(text: string): { hasFrontmatter: boolean; name?: string; description?: string; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { hasFrontmatter: false, body: text };
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { hasFrontmatter: false, body: text };
  const fmLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n");
  const out: { hasFrontmatter: boolean; name?: string; description?: string; body: string } = {
    hasFrontmatter: true,
    body,
  };
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}

function deriveName(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return (
    dir
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

function deriveDescription(body: string, name: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  let candidate = lines.find((line) => line.length > 0) ?? "";
  if (candidate.startsWith("#")) candidate = candidate.replace(/^#+\s*/, "");
  const desc = candidate.length > 0 ? candidate : `Skill for ${name}.`;
  return desc;
}

async function listSkills(root: string): Promise<SkillSummary[]> {
  const out: SkillSummary[] = [];
  if (!existsSync(root)) return out;
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (entry.name !== "SKILL.md") continue;
      const raw = await fs.readFile(full, "utf8");
      const parsed = parseFrontmatter(raw);
      const name = parsed.name?.trim() || deriveName(full);
      const description = parsed.description?.trim() || deriveDescription(parsed.body, name);
      out.push({
        name,
        description,
        relativePath: path.relative(root, full),
      });
    }
  };
  await walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function renderAutoBlock(params: {
  generatedAt: string;
  registrySource: string;
  skillsSource: string | null;
  upstreams: Upstream[];
  skills: SkillSummary[];
  commands: CommandSummary[];
}): string {
  const lines: string[] = [];
  lines.push("<!-- Mx:auto:start -->");
  lines.push("## MCP Manager Inventory (auto-generated)");
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Registry source: ${params.registrySource}`);
  lines.push(`Skills source: ${params.skillsSource ?? "(none found)"}`);
  lines.push("");
  lines.push("### MCP servers");
  if (params.upstreams.length === 0) {
    lines.push("- (none)");
  } else {
    for (const upstream of params.upstreams) {
      const args = upstream.args?.length ? ` ${upstream.args.join(" ")}` : "";
      const status = upstream.enabled ? "enabled" : "disabled";
      const envVars = upstream.env_vars?.length ? ` env_vars=${upstream.env_vars.join(",")}` : "";
      lines.push(`- ${upstream.id} (${status}): ${upstream.command}${args}${envVars}`);
    }
  }
  lines.push("");
  lines.push("Usage: tools are available via the Mx gateway; call Mx_upstreams_list.");
  lines.push("Use prefixed tool names like <id>__<tool> (aliases exist only when unique).");
  lines.push("");
  lines.push("### Skills");
  if (params.skills.length === 0) {
    lines.push("- (none)");
  } else {
    for (const skill of params.skills) {
      lines.push(`- ${skill.name}: ${skill.description} (${skill.relativePath})`);
    }
  }
  lines.push("");
  lines.push("Usage: Codex loads SKILL.md from ~/.codex/skills; Claude Code loads from ~/.claude/skills.");
  lines.push("Reference by name in prompts; in Codex you can use $skill-name if skills are enabled.");
  lines.push("");
  lines.push("### Commands");
  if (params.commands.length === 0) {
    lines.push("- (none)");
  } else {
    for (const cmd of params.commands) {
      lines.push(`- ${cmd.target}/${cmd.scope}: /${cmd.name} (${cmd.relativePath})`);
    }
  }
  lines.push("");
  lines.push("Usage: Claude commands live in ~/.claude/commands or .claude/commands (project).");
  lines.push("Codex commands live in ~/.codex/prompts. Use / to trigger them.");
  lines.push("<!-- Mx:auto:end -->");
  return lines.join("\n");
}

function upsertAutoBlock(text: string, block: string): string {
  const start = "<!-- Mx:auto:start -->";
  const end = "<!-- Mx:auto:end -->";
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = text.slice(0, startIdx).trimEnd();
    const after = text.slice(endIdx + end.length).trimStart();
    const joinerBefore = before.length > 0 ? "\n\n" : "";
    const joinerAfter = after.length > 0 ? "\n\n" : "\n";
    return before + joinerBefore + block + joinerAfter + after;
  }
  const trimmed = text.trimEnd();
  const prefix = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + prefix + block + "\n";
}

async function ensureInstructions({
  repo,
  sourceRoot,
  force,
}: {
  repo: string;
  sourceRoot: string;
  force: boolean;
}) {
  const agentsPath = path.join(repo, "AGENTS.md");
  const legacyAgentsPath = path.join(repo, "agents.md");
  const claudePath = path.join(repo, "CLAUDE.md");

  const registrySourceCandidate = path.join(sourceRoot, "registry.json");
  const registrySource = existsSync(registrySourceCandidate) ? registrySourceCandidate : registryPath();
  const registry = await readRegistryFile(registrySource);
  const skillsSourceCandidate = path.join(sourceRoot, "skills");
  const skillsSource = existsSync(skillsSourceCandidate) ? skillsSourceCandidate : null;
  const skills = skillsSource ? await listSkills(skillsSource) : [];
  const commands = await listSourceCommands(path.join(sourceRoot, "commands"));

  const generatedAt = new Date().toISOString();
  const block = renderAutoBlock({
    generatedAt,
    registrySource,
    skillsSource,
    upstreams: registry.upstreams,
    skills,
    commands,
  });

  let base = "";
  if (existsSync(agentsPath)) {
    base = await fs.readFile(agentsPath, "utf8");
  } else if (existsSync(legacyAgentsPath)) {
    base = await fs.readFile(legacyAgentsPath, "utf8");
  } else {
    base = "# AGENTS\n\nProject instructions for agentic tooling.\n";
  }
  const updated = upsertAutoBlock(base, block);
  await fs.writeFile(agentsPath, updated, "utf8");

  let claudeStatus = "unchanged";
  if (!existsSync(claudePath)) {
    await fs.symlink("AGENTS.md", claudePath);
    claudeStatus = "created";
  } else {
    const stat = await fs.lstat(claudePath);
    if (stat.isSymbolicLink()) {
      claudeStatus = "exists";
    } else if (force) {
      const backup = `${claudePath}.bak.${Math.floor(Date.now() / 1000)}`;
      await fs.copyFile(claudePath, backup);
      await fs.unlink(claudePath);
      await fs.symlink("AGENTS.md", claudePath);
      claudeStatus = `replaced (backup: ${backup})`;
    } else {
      claudeStatus = "skipped (existing file)";
    }
  }

  return {
    repo,
    agentsPath,
    claudePath,
    registrySource,
    skillsSource,
    claudeStatus,
    upstreamCount: registry.upstreams.length,
    skillCount: skills.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.cmd === "help") {
    printHelp();
    return;
  }

  if (args.cmd === "install") {
    const migration = await migrateLegacyHomeLayout();
    await buildGateway(args.verbose);
    const gw = await installGatewayBinary();
    const codex = await installCodexConfig(gw.gatewayPath);
    const desktop = await installClaudeDesktopConfig(gw.gatewayPath);
    const claude = await installClaudeCodeConfig(gw.gatewayPath);
    console.log(
      JSON.stringify(
        {
          gateway: gw.gatewayPath,
          gateway_mode: gw.mode,
          ...(gw.mode === "local" ? { warning: gw.warning } : {}),
          migration,
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

  if (args.cmd === "instructions") {
    const repo = args.repo ?? process.cwd();
    const sourceRoot = args.sourceDir ?? sourceDir();
    const res = await ensureInstructions({ repo, sourceRoot, force: args.force });
    console.log(JSON.stringify(res, null, 2));
    return;
  }
}

await main();
