# mcpManager

CLI + local MCP gateway to centralize MCP server configs and manage Playwright pool sessions.

## Quickstart (CLI)

Prereqs:
- Bun (`bun --version`)

Install + register the MCP gateway (Codex + Claude Desktop + Claude Code if present):
- `bun install`
- `bun run setup`

Optional env:
- `export MCPMANAGER_REGISTRY_PATH=...` (override registry path)
- `export MCPMANAGER_PLAYWRIGHT_POOL=playwright1,playwright2`
- `export MCPMANAGER_INTERACTIONS_DIR=...` (store interactions)

Centralize your existing MCP servers (Codex + Claude Code) behind the single `mcpmanager` entry:
- Dry run: `bun run centralize`
- Apply changes: `bun run centralize -- --apply`

Remove `mcpmanager` and restore direct servers:
- `bun run decentralize`

Restart Codex / Claude Desktop after setup so they reload the configs.

## Standalone binaries (optional)

- `bun run build:gateway:exe`
- `bun run build:manager:exe`

Build output lands in `apps/gateway/dist/` as `mcpmanager-gateway` and `mcpmanager`.

## What's implemented

- CLI to centralize upstream MCP servers into `~/.mcpmanager/registry.json` and toggle configs in Codex/Claude.
- Gateway that proxies upstream tools, exposes Playwright pool helpers, and can run Codex/Claude CLIs via shell.
- Gateway also exposes an Interactions-like API backed by Claude CLI (tools, background runs, basic multimodal inputs).

## LLM stdio bridge (local)

The gateway exposes helpers that run the Codex and Claude CLIs via Bun's shell:
- `llm.codex.exec` (args: `args[]`, `stdin` optional)
- `llm.claude.exec` (args: `args[]`, `stdin` optional)

Shell smoke test (runs `--help`/`--version`, and attempts a "hello world" prompt if detected):
- `bun run test:llm-shell`
- Optional overrides:
  - `MCPMANAGER_CODEX_HELLO_ARGS`
  - `MCPMANAGER_CODEX_HELLO_STDIN`
  - `MCPMANAGER_CLAUDE_HELLO_ARGS`
  - `MCPMANAGER_CLAUDE_HELLO_STDIN`
  - `MCPMANAGER_LLM_TIMEOUT_MS` (default 20000)

## Interactions API (Claude-backed)

MCP tools:
- `interactions.create` (supports `previous_interaction_id`, `tools`, and `background`)
- `interactions.get`
- `interactions.delete`

Notes:
- `background: true` requires `store: true` and returns `status: "in_progress"` until complete.
- Tool calls return `outputs` with `type: "function_call"` and `status: "requires_action"`.
- Multimodal inputs accept content parts like `{ type: "image", data, mime_type }`.

Smoke test (creates a session, follows up, tool call, background run, reads, deletes):
- `bun run test:interactions-claude`
  - `MCPMANAGER_IMAGE_TEST=1` to include an optional image input check.

## Playwright parallelism (local)

If you run multiple Playwright MCP servers as upstreams, you can enable a simple cross-process reservation lock:
- Set `MCPMANAGER_PLAYWRIGHT_POOL=playwright1,playwright2` (upstream IDs in `~/.mcpmanager/registry.json`)
- Call `playwright_pool.reserve` or `playwright_pool.session.start` to get an `upstreamId`
- Use only that prefix for tool calls (e.g. `playwright1.browser_navigate`)

Smoke test (runs 2 agents in parallel and asserts distinct slots are held concurrently):
- `bun run test:playwright-pool`
- `MCPMANAGER_PLAYWRIGHT_HEADED=1 bun run test:playwright-pool` to see browsers

Note: `playwright_pool.session.start` creates a new tab by default. Reuse the returned `sessionId`,
or pass a stable `sessionKey` (and/or `newTab: false`) to avoid tab spam.

Installer output:
- Gateway binary at `~/.mcpmanager/bin/mcpmanager-gateway`
- Codex config: `~/.codex/config.toml`
- Claude Desktop (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Code CLI: `claude mcp add-json mcpmanager --scope user ...` (if available)
