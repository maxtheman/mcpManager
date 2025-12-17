# mcpManager

Desktop app + local MCP gateway to manage Codex / Claude configs and provide a single MCP entry that proxies Daytona + Tailscale actions.

## Quickstart (CLI)

Prereqs:
- Bun (`bun --version`)
- Rust (`rustc --version`)

Install + register the MCP gateway (Codex + Claude Desktop + Claude Code if present):
- `bun install`
- `bun run setup`

Set credentials (optional, but required for Daytona/Tailscale tools):
- `export DAYTONA_API_KEY=...`
- `export DAYTONA_SERVER_URL=...` (or `DAYTONA_API_URL`)
- `export DAYTONA_TARGET=...` (optional)
- `export TAILSCALE_API_KEY=...`
- `export TAILSCALE_TAILNET=...` (optional; defaults to `-`)

Re-run setup after exporting env vars if you want them written into client configs:
- `bun run setup`

Verify everything is wired up (includes an MCP stdio ping):
- `bun run doctor`

Centralize your existing MCP servers (Codex + Claude Code) behind the single `mcpmanager` entry:
- Dry run: `bun run centralize`
- Apply changes: `bun run centralize -- --apply`

Remove `mcpmanager` and restore direct servers:
- `bun run decentralize`

Safety note (Tailscale):
- By default, `tailscale.keys.createEphemeral` is blocked unless you set `MCPMANAGER_TAILSCALE_ALLOW_KEYS=1`.

Restart Codex / Claude Desktop after setup so they reload the configs.

## Desktop app (dev)

- `bun run dev:desktop`

## Packaging (no Bun at runtime)

The desktop app bundles `mcpmanager-gateway` as a Tauri sidecar and copies it to `~/.mcpmanager/bin/` on install, so end users don’t need Bun installed. (Bun is still required to build the sidecar during development.)

## What’s implemented

- A single MCP server `mcpmanager` (stdio) that exposes:
  - `health.ping`
  - `daytona.*` (create/delete sandbox, exec commands)
  - `tailscale.*` (list devices, create auth keys)

## Playwright parallelism (local)

If you run multiple Playwright MCP servers as upstreams, you can enable a simple cross-process reservation lock:
- Set `MCPMANAGER_PLAYWRIGHT_POOL=playwright1,playwright2` (upstream IDs in `~/.mcpmanager/registry.json`)
- Call `playwright_pool.reserve` to get an `upstreamId`
- Use only that prefix for tool calls (e.g. `playwright1.browser_navigate`)

Smoke test (runs 2 “agents” concurrently and asserts they reserve different slots):
- `bun run test:playwright-pool`
- Installer that puts the gateway at `~/.mcpmanager/bin/mcpmanager-gateway` and registers it into:
  - Codex: `~/.codex/config.toml`
  - Claude Desktop (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Claude Code CLI: `claude mcp add-json mcpmanager --scope user ...` (if available)
