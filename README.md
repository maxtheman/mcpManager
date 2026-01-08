# Mx

CLI + local MCP gateway to centralize MCP server configs and manage Playwright pool sessions.

## Quickstart (CLI)

Prereqs:
- Bun (`bun --version`)

Install + register the MCP gateway (Codex + Claude Desktop + Claude Code if present):
- `bun install`
- `bun run setup`

Optional env:
- `export MX_REGISTRY_PATH=...` (override registry path)
- `export MX_SOURCE_DIR=...` (central source root for registry.json + skills/)
- `export MX_PLAYWRIGHT_POOL=...` (comma list, or `auto` to detect Playwright MCPs, or `off` to disable pooling)
- `export MX_INTERACTIONS_DIR=...` (store interactions)

Centralize your existing MCP servers (Codex + Claude Code) behind the single `Mx` entry:
- Dry run: `bun run centralize`
- Apply changes: `bun run centralize -- --apply`

Remove `Mx` and restore direct servers:
- `bun run decentralize`

Restart Codex / Claude Desktop after setup so they reload the configs.

## Standalone binaries (optional)

- `bun run build:gateway:exe`
- `bun run build:manager:exe`

Build output lands in `apps/gateway/dist/` as `Mx-gateway` and `Mx`.

## What's implemented

- CLI to centralize upstream MCP servers into `~/.Mx/registry.json` and toggle configs in Codex/Claude.
- Gateway that proxies upstream tools, exposes Playwright pool helpers, and can run Codex/Claude CLIs via shell.
- Gateway also exposes an Interactions-like API backed by Claude CLI (tools, background runs, basic multimodal inputs).
- Skills validation + analysis (CLI + MCP tools) and a skills sync helper from `MX_SOURCE_DIR/skills`.
- Commands sync support for Claude Code (`~/.claude/commands`) and Codex (`~/.codex/prompts`) from `MX_SOURCE_DIR/commands`.

Refactor notes / roadmap: `docs/mx-refactor.md`
Playwright scaling: `docs/playwright-pool-scale.md`

## LLM stdio bridge (local)

The gateway exposes helpers that run the Codex and Claude CLIs via Bun's shell:
- `llm_codex_exec` (args: `args[]`, `stdin` optional)
- `llm_claude_exec` (args: `args[]`, `stdin` optional)

Shell smoke test (runs `--help`/`--version`, and attempts a "hello world" prompt if detected):
- `bun run test:llm-shell`
- Optional overrides:
  - `MX_CODEX_HELLO_ARGS`
  - `MX_CODEX_HELLO_STDIN`
  - `MX_CLAUDE_HELLO_ARGS`
  - `MX_CLAUDE_HELLO_STDIN`
  - `MX_LLM_TIMEOUT_MS` (default 20000)

## Interactions API (Claude-backed)

MCP tools:
- `interactions_create` (supports `previous_interaction_id`, `background`, and `stream`)
- `interactions_get`
- `interactions_delete`

Notes:
- `background: true` requires `store: true` and returns `status: "in_progress"` until complete.
- `tools`/`tool_choice` are not supported; the Claude CLI manages tools directly.
- Multimodal inputs accept content parts like `{ type: "image", data, mime_type }`.

Smoke test (creates a session, follows up, background run, reads, deletes):
- `bun run test:interactions-claude`
  - `MX_IMAGE_TEST=1` to include an optional image input check.

## Playwright parallelism (local)

If you run multiple Playwright MCP servers as upstreams, the pool auto-detects them (or set an explicit list):
- Set `MX_PLAYWRIGHT_POOL=auto` (default when unset) or `MX_PLAYWRIGHT_POOL=playwright1,playwright2`
- Call `playwright_pool_reserve` or `playwright_pool_session_start` to get an `upstreamId`
- Use only that prefix for tool calls (e.g. `playwright1__browser_navigate`)

Smoke test (runs 2 agents in parallel and asserts distinct slots are held concurrently):
- `bun run test:playwright-pool`
- `MX_PLAYWRIGHT_HEADED=1 bun run test:playwright-pool` to see browsers

Note: `playwright_pool_session_start` creates a new tab by default. Reuse the returned `sessionId`,
or pass a stable `sessionKey` (and/or `newTab: false`) to avoid tab spam across restarts.
Locks auto-expire after 15 minutes of inactivity by default (TTL is refreshed on slot usage).

Operational helpers:
- `playwright_pool_status` shows lock/pid status and drift vs the registry `playwright_pool` generator config.
- `playwright_pool_session_end` defaults to keeping the tab open when a `sessionKey` was used (pass `closeTab: true` and/or `forget: true` to clean up).

## Skills validation (CLI)

- `bun run skills validate --target both`
- `bun run skills analyze --target codex`
- `bun run skills sync --source-dir ~/.Mx/source`

Optional manifest:
- `~/.Mx/source/skills/manifest.json` controls which **top-level skill directories** sync to `~/.codex/skills` and `~/.claude/skills`.
- Unlisted skills default to enabled (override via `defaults` or explicit `skills.<id>` entries).

Installer output:
- Gateway binary at `~/.Mx/bin/Mx-gateway`
- Codex config: `~/.codex/config.toml`
- Claude Desktop (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Code CLI: `claude mcp add-json Mx --scope user ...` (if available)
