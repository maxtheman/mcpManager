# Mx refactor: maintainability + UX

## Scope / intent
This doc captures a refactor direction for the **gateway** (`apps/gateway/src/entry/cli.ts`) and the **skills tooling**. It assumes ADO + Chrome extension are removed and the repo is focused on:

- Registry centralization (`~/.Mx/registry.json`)
- Gateway proxying (built-ins + upstream tool routing)
- Playwright pool + session management
- Interactions (Claude CLI-backed)
- Skills + commands sync/validation

## Current state (high level)

### Entrypoints
- `apps/gateway/src/entry/cli.ts`: MCP stdio server (tool list + tool handler routing)
- `apps/gateway/src/entry/manager-cli.ts`: local installer + config centralize/decentralize
- `apps/gateway/src/entry/skills-cli.ts`: skills validate/analyze/sync (CLI)

### Domains (core)
- `apps/gateway/src/core/playwright-sessions/*`: in-process Playwright session manager + MCP tools
- `apps/gateway/src/core/skills/*`: skill validation, analysis, sync
- `apps/gateway/src/core/commands/*`: command inventory + sync
- `apps/gateway/src/core/sync.ts`: registry/skills/commands sync orchestration
- `apps/gateway/src/infra/*`: filesystem-backed registry + process helpers
- `apps/gateway/src/shared/*`: env + paths helpers

### Immediate pain points
1) `apps/gateway/src/entry/cli.ts` is monolithic: it owns tool defs, routing, state, and business logic.
2) Response shapes are not standardized (some tools return `{ ok, ... }`, others return raw upstream content).
3) Domain code is partially structured, but the “public surface” is still implicitly defined by `cli.ts`.
4) There are multiple CLIs (`manager`, `skills`, `gateway`) with different argument parsing and output conventions.

## Refactor goals
- **Keep behavior stable** for MCP tools (same tool names + input schemas) while improving internal structure.
- **Make adding a new tool boring**: one module, one schema, one handler, consistent output.
- **Make UX predictable** across CLIs: shared flags (`--format`, `--dry-run`, `--apply`, `--source-dir`, `--json`), consistent help.
- **Minimize shared mutable state** in `cli.ts` (push state down into domain modules or an explicit “GatewayRuntime”).

Non-goals (for this refactor):
- Introducing a new framework (no commander/oclif rewrite)
- Changing upstream MCP behavior (proxy stays a proxy)
- Replacing Bun or Playwright

## Proposed structure

### 1) Tool modules + router
Introduce a small internal contract for built-in tool modules:

```ts
export type McpToolModule = {
  defs: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  canHandle: (name: string) => boolean;
  handle: (name: string, args: Record<string, unknown>, ctx: GatewayContext) => Promise<{ content: any[] } | null>;
};
```

Then make `apps/gateway/src/entry/cli.ts` mostly:
- Build `GatewayContext` (registry, upstream clients, pool state, interactions store)
- Collect `toolDefs` from modules
- On call: dispatch to first module where `canHandle(name)` is true
- Fallback to upstream routing

Suggested modules:
- `core/playwright-sessions/mcp-tools.ts` (already close)
- `core/skills/mcp-tools.ts` (new wrapper around validator/analyzer/sync)
- `core/commands/mcp-tools.ts` (sync/list)
- `core/interactions/mcp-tools.ts` (create/get/delete/events/cancel)
- `core/llm-shell/mcp-tools.ts` (claude/codex exec)
- `core/registry/mcp-tools.ts` (upstreams list/reload/enabled/active)
- `core/playwright-pool/mcp-tools.ts` (reserve/release/session_* tools)

### 2) Standardize tool responses
Adopt a single JSON envelope for text responses (even if we also pass-through upstream content):

```json
{ "ok": true, "data": { ... }, "meta": { ... } }
{ "ok": false, "error": "..." }
```

Benefits:
- Fewer bespoke client-side parsers
- Easier to add `--format json` symmetry for CLIs
- Easier to log and test

### 3) Centralize config + env parsing
Create `shared/config.ts` that owns:
- registry path resolution
- source dir resolution
- pool enablement + configured pool IDs
- interactions dir path resolution
- timeouts (LLM and tool timeouts)

Goal: remove “env logic sprawl” from `cli.ts`.

### 4) CLI UX consolidation
Target end-state:

- `Mx gateway` (stdio MCP server, current `Mx-gateway`)
- `Mx install` / `Mx centralize` / `Mx decentralize` (current manager)
- `Mx skills validate|analyze|sync` (current skills CLI)

Incremental approach:
1) Keep binaries as-is, but align flags + output format (text/json) and help.
2) Add a new unified entrypoint that shells out to existing flows (or imports and dispatches).
3) Deprecate old CLIs once stable.

### 5) Keep “seams” explicit
Define and enforce seams:
- `entry/*` may depend on `core/*`, `infra/*`, `shared/*`
- `core/*` may depend on `infra/*`, `shared/*`
- `infra/*` depends only on `shared/*`

This already matches the existing sheriff boundary direction; the refactor should make seams more obvious by directory and naming.

## Proposed execution plan (low-risk increments)
1) Extract a `toolRouter` from `apps/gateway/src/entry/cli.ts` (no behavior change)
2) Move each tool family into its own module (start with Playwright sessions + skills since they’re already modular)
3) Standardize responses for built-ins (leave upstream proxy pass-through untouched initially)
4) Unify CLI flags across `manager-cli.ts` and `skills-cli.ts`
5) Add `Mx doctor` (sanity checks: Bun present, cli binaries detectable, paths writable, registry parseable)

## Notes on skills
The gateway already supports a “source root” (`MX_SOURCE_DIR`) containing:
- `registry.json`
- `skills/`
- `commands/`

To make this easier to use in-repo:
- Keep a repo-local seed like `mx_source/` (optional)
- Add docs and CLI sugar to sync from the seed into `~/.Mx/source`
