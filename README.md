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

## What’s implemented

- A single MCP server `mcpmanager` (stdio) that exposes:
  - `health.ping`
  - `daytona.*` (create/delete sandbox, exec commands)
  - `tailscale.*` (list devices, create auth keys)
- Installer that puts the gateway at `~/.mcpmanager/bin/mcpmanager-gateway` and registers it into:
  - Codex: `~/.codex/config.toml`
  - Claude Desktop (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Claude Code CLI: `claude mcp add-json mcpmanager --scope user ...` (if available)
