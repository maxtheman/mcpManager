# Playwright pool scaling (registry-backed)

## What “pool size” means
The Playwright pool has **1 slot per configured upstream id**. If you want 20 concurrent isolated Playwright MCP instances, you need 20 upstream entries in `~/.Mx/registry.json` (or a generator that produces them).

## `playwright_pool_scale` (MCP tool)
Scales pool capacity by cloning a template upstream into numbered upstreams (e.g. `playwright1..playwrightN`).

Input:
- `count` (required): desired number of cloned slots
- `templateUpstreamId` (default: `playwright`): upstream to clone
- `idPrefix` (default: `playwright`): clone id prefix
- `prune` (default: `false`): when scaling down, remove clones (true) or disable them (false)
- `dry_run` (default: `false`): show plan only
- `reload` (default: `true`): reload registry in the current gateway process

Notes:
- The template upstream is **not** counted as a slot; slots are the clones.
- Clones get safe per-slot cache env vars by default to avoid `npx` races when scaling up.

## Recommended setup
- Prefer the compiled gateway binary (`~/.Mx/bin/Mx-gateway`) in Codex/Claude configs; avoid `bun --hot` for reliability.
- Use `MX_PLAYWRIGHT_POOL=auto` (or leave it unset) so the pool auto-detects `playwright*` upstream ids.

## `playwright_pool_status` (MCP tool)
Returns a superset of `playwright_pool_list`, including:
- lock files + pid liveness/expiry
- per-slot reasons when unavailable
- detected `registry.playwright_pool` generator config and drift (if any)
