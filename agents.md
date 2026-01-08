# Agent Notes (Mx)

This repo is a local MCP gateway + CLI for:
- Centralizing MCP server configuration into a single `Mx` entry
- Managing a local Playwright pool lock (parallelism without tab spam)
- Providing thin bridges to vendor CLIs (Claude now, Codex later)
- Validating/analyzing/syncing local “skills” and command packs

Focus areas:
- Keep tool surfaces stable (names + input/output JSON)
- Prefer small, composable modules in `apps/gateway/src/core/*`
- Treat `apps/gateway/src/entry/*` as orchestration (thin glue)
