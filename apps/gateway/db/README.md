# HelixDB Schema & Queries

This directory contains the HelixDB schema and queries for the gateway.

## Files

- `schema.hx` - Node and edge type definitions
- `queries.hx` - HelixQL queries for all CRUD operations

## Query Pattern: Return Whole Nodes

All queries in this repo use `RETURN node` instead of projections like `RETURN node::{ field: _::{field} }`.

**Why?**
1. Projections (`::{ ... }`) exclude the `id` field from responses
2. Returning whole nodes (`RETURN node`) includes `id` automatically
3. This enables proper entity chaining (create -> use id)

```helixql
// CORRECT - returns id + all fields
QUERY CreatePool(pool_key: String, kind: String, now_ms: U64) =>
  pool <- AddN<Pool>({...})
  RETURN pool

// WRONG - excludes id field
QUERY CreatePool(pool_key: String, kind: String, now_ms: U64) =>
  pool <- AddN<Pool>({...})
  RETURN pool::{ pool_key: _::{pool_key}, kind: _::{kind} }
```

## Known Issues

### `_::ID` Codegen Bug (HelixDB v2.1.10)

Using `id: _::ID` in projection RETURN statements causes Rust codegen to generate duplicate `id` fields.

```helixql
// CAUSES RUST COMPILE ERROR
RETURN user::{ id: _::ID, name: _::{name} }
```

**Solution**: Return whole nodes (`RETURN node`) instead of projections.

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
