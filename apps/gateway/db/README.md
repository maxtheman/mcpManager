# HelixDB Schema & Queries

This directory contains the HelixDB schema and queries for the gateway.

## Files

- `schema.hx` - Node and edge type definitions
- `queries.hx` - HelixQL queries for all CRUD operations

## Known Issues & Workarounds

### `_::ID` Codegen Bug (HelixDB v2.1.10)

**Problem**: Using `_::ID` in RETURN statements causes Rust codegen to generate duplicate `id` fields, failing cargo compilation.

```helixql
// BAD - causes duplicate field error
RETURN user::{ id: _::ID, name: _::{name} }
```

**Workaround**: Omit `id: _::ID` from RETURN statements. HelixDB auto-includes an `id` field in the generated Rust struct.

```helixql
// GOOD - id is auto-included
RETURN user::{ name: _::{name}, email: _::{email} }
```

**Status**: Bug reported via Helix CLI auto-issue. Workaround applied to all queries in this repo.

### UPDATE Operations Fail (HelixDB v2.1.10)

**Problem**: All UPDATE operations fail with "Graph error: Unsupported value type", regardless of parameter types.

```helixql
// FAILS - even with String-only params
s <- N<Snapshot>({snapshot_key: snapshot_key})
updated <- s::UPDATE({status: status})
RETURN updated::{ status: _::{status} }
```

**Workaround**: Set final values at creation time instead of updating. For snapshots, we set `status: "complete"` in `CreateSnapshotByRepoName` since files are added atomically.

**Status**: Unresolved. UPDATE queries are defined but non-functional.

## Commands

```bash
# Validate syntax
cd apps/gateway && helix check

# Push to local dev instance (requires Docker)
cd apps/gateway && helix push dev

# Start dashboard (after push)
cd apps/gateway && helix dashboard start
```

## Configuration

See `helix.toml` in the gateway root for instance configuration.
