// ============================================================================
// Playwright Session Manager - HelixQL Queries
// ============================================================================
//
// This file contains all HelixQL queries for the Playwright Session Manager.
// Queries are organized by category and correspond to the schema in schema.hx.
//
// Query Categories:
//   1. Pool CRUD - Create/read/update pool records
//   2. Session CRUD - Session lifecycle management
//   3. Context CRUD - BrowserContext operations
//   4. Tab CRUD - Tab/Page operations
//   5. Command Audit - Tool call history tracking
//   6. Introspection - List and query operations
//   7. Janitor - Cleanup and expiration queries
//
// ============================================================================


// ============================================================================
// 1. POOL CRUD
// ============================================================================

QUERY CreatePool(pool_key: String, kind: String, now_ms: U64) =>
  pool <- AddN<Pool>({
    pool_key: pool_key,
    kind: kind,
    created_at_ms: now_ms,
    last_heartbeat_at_ms: now_ms,
  })
  RETURN pool

QUERY GetPoolByKey(pool_key: String) =>
  pool <- N<Pool>({pool_key: pool_key})
  RETURN pool

QUERY GetPool(pool_id: ID) =>
  pool <- N<Pool>(pool_id)
  RETURN pool

QUERY UpdatePoolHeartbeat(pool_id: ID, now_ms: U64) =>
  pool <- N<Pool>(pool_id)
  updated <- pool::UPDATE({last_heartbeat_at_ms: now_ms})
  RETURN updated

QUERY DeletePool(pool_id: ID) =>
  DROP N<Pool>(pool_id)
  RETURN "deleted"


// ============================================================================
// 2. SESSION CRUD
// ============================================================================

QUERY CreateSession(
  pool_id: ID,
  pool_key: String,
  session_key: String,
  owner_agent: String,
  ttl_seconds: U32,
  expires_at_ms: U64,
  now_ms: U64,
  metadata_json: String
) =>
  session <- AddN<Session>({
    session_key: session_key,
    pool_key: pool_key,
    owner_agent: owner_agent,
    status: "starting",
    created_at_ms: now_ms,
    updated_at_ms: now_ms,
    ttl_seconds: ttl_seconds,
    expires_at_ms: expires_at_ms,
    active_tab_id: "",
    metadata_json: metadata_json,
    last_error: "",
  })
  link <- AddE<PoolHasSession>({created_at_ms: now_ms})::From(pool_id)::To(session)
  RETURN session

QUERY GetSession(session_id: ID) =>
  s <- N<Session>(session_id)
  RETURN s

QUERY GetSessionByKey(session_key: String) =>
  s <- N<Session>({session_key: session_key})
  RETURN s

QUERY UpdateSessionStatus(session_id: ID, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated

QUERY UpdateSessionActiveTab(session_id: ID, tab_id: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({active_tab_id: tab_id, updated_at_ms: now_ms})
  RETURN updated

QUERY UpdateSessionError(session_id: ID, error: String, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({last_error: error, status: status, updated_at_ms: now_ms})
  RETURN updated

QUERY ExtendSessionTTL(session_id: ID, new_expires_at_ms: U64, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({expires_at_ms: new_expires_at_ms, updated_at_ms: now_ms})
  RETURN updated

QUERY EndSession(session_id: ID, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated

QUERY DeleteSession(session_id: ID) =>
  DROP N<Session>(session_id)
  RETURN "deleted"


// ============================================================================
// 3. CONTEXT CRUD
// ============================================================================

QUERY CreateContext(
  session_id: ID,
  context_key: String,
  now_ms: U64,
  browser_type: String,
  options_json: String
) =>
  ctx <- AddN<Context>({
    context_key: context_key,
    status: "open",
    created_at_ms: now_ms,
    closed_at_ms: 0,
    browser_type: browser_type,
    options_json: options_json,
  })
  link <- AddE<SessionHasContext>({created_at_ms: now_ms})::From(session_id)::To(ctx)
  RETURN ctx

QUERY GetContext(context_id: ID) =>
  ctx <- N<Context>(context_id)
  RETURN ctx

QUERY GetContextByKey(context_key: String) =>
  ctx <- N<Context>({context_key: context_key})
  RETURN ctx

QUERY GetSessionContext(session_id: ID) =>
  ctx <- N<Session>(session_id)::Out<SessionHasContext>
  RETURN ctx

QUERY CloseContext(context_id: ID, status: String, now_ms: U64) =>
  ctx <- N<Context>(context_id)
  updated <- ctx::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated

QUERY MarkContextOrphaned(context_id: ID, status: String, now_ms: U64) =>
  ctx <- N<Context>(context_id)
  updated <- ctx::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated

QUERY DeleteContext(context_id: ID) =>
  DROP N<Context>(context_id)
  RETURN "deleted"


// ============================================================================
// 4. TAB CRUD
// ============================================================================

QUERY AddTab(
  context_id: ID,
  tab_key: String,
  opener_tab_id: String,
  is_popup: Boolean,
  now_ms: U64,
  tab_index: U32,
  url: String,
  title: String
) =>
  tab <- AddN<Tab>({
    tab_key: tab_key,
    status: "open",
    created_at_ms: now_ms,
    closed_at_ms: 0,
    last_seen_at_ms: now_ms,
    url: url,
    title: title,
    opener_tab_id: opener_tab_id,
    is_popup: is_popup,
  })
  link <- AddE<ContextHasTab>({created_at_ms: now_ms, tab_index: tab_index})::From(context_id)::To(tab)
  RETURN tab

QUERY GetTab(tab_id: ID) =>
  t <- N<Tab>(tab_id)
  RETURN t

QUERY GetTabByKey(tab_key: String) =>
  t <- N<Tab>({tab_key: tab_key})
  RETURN t

QUERY UpdateTabUrl(tab_id: ID, url: String, title: String, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({url: url, title: title, last_seen_at_ms: now_ms})
  RETURN updated

QUERY UpdateTabLastSeen(tab_id: ID, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({last_seen_at_ms: now_ms})
  RETURN updated

QUERY CloseTab(tab_id: ID, status: String, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated

QUERY DeleteTab(tab_id: ID) =>
  DROP N<Tab>(tab_id)
  RETURN "deleted"


// ============================================================================
// 5. COMMAND AUDIT
// ============================================================================

QUERY RecordCommand(
  session_id: ID,
  tab_id: ID,
  seq: U64,
  tool: String,
  args_json: String,
  ok: Boolean,
  started_at_ms: U64,
  duration_ms: U32,
  error: String
) =>
  cmd <- AddE<SessionCommand>({
    seq: seq,
    tool: tool,
    args_json: args_json,
    ok: ok,
    started_at_ms: started_at_ms,
    duration_ms: duration_ms,
    error: error,
  })::From(session_id)::To(tab_id)
  RETURN cmd

QUERY GetSessionCommands(session_id: ID) =>
  cmds <- N<Session>(session_id)::OutE<SessionCommand>
  RETURN cmds

QUERY GetTabCommands(tab_id: ID) =>
  cmds <- N<Tab>(tab_id)::InE<SessionCommand>
  RETURN cmds

QUERY GetFailedCommands(session_id: ID) =>
  cmds <- N<Session>(session_id)::OutE<SessionCommand>::WHERE(_::{ok}::EQ(false))
  RETURN cmds


// ============================================================================
// 6. INTROSPECTION QUERIES
// ============================================================================

QUERY ListPools() =>
  pools <- N<Pool>
  RETURN pools

QUERY ListPoolSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>
  RETURN sessions

QUERY ListSessionsByOwner(owner_agent: String) =>
  sessions <- N<Session>::WHERE(_::{owner_agent}::EQ(owner_agent))
  RETURN sessions

QUERY ListSessionsByStatus(status: String) =>
  sessions <- N<Session>::WHERE(_::{status}::EQ(status))
  RETURN sessions

QUERY ListSessionTabs(session_id: ID) =>
  ctx <- N<Session>(session_id)::Out<SessionHasContext>
  tabs <- ctx::Out<ContextHasTab>
  RETURN tabs

QUERY ListContextTabs(context_id: ID) =>
  tabs <- N<Context>(context_id)::Out<ContextHasTab>
  RETURN tabs

QUERY ListOpenTabs(context_id: ID) =>
  tabs <- N<Context>(context_id)::Out<ContextHasTab>::WHERE(_::{status}::EQ("open"))
  RETURN tabs

QUERY CountPoolSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>
  RETURN sessions::COUNT

QUERY CountActiveSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>::WHERE(_::{status}::EQ("active"))
  RETURN sessions::COUNT


// ============================================================================
// 7. JANITOR QUERIES
// ============================================================================

QUERY ListExpiredSessions(now_ms: U64) =>
  expired <- N<Session>::WHERE(_::{status}::NEQ("ended"))
                        ::WHERE(_::{status}::NEQ("failed"))
                        ::WHERE(_::{expires_at_ms}::LT(now_ms))
  RETURN expired

QUERY ListOrphanedContexts() =>
  orphaned <- N<Context>::WHERE(_::{status}::EQ("orphaned"))
  RETURN orphaned

QUERY ListStalePools(cutoff_ms: U64) =>
  stale <- N<Pool>::WHERE(_::{last_heartbeat_at_ms}::LT(cutoff_ms))
  RETURN stale

QUERY ListEndedSessions(cutoff_ms: U64) =>
  ended <- N<Session>::WHERE(_::{status}::EQ("ended"))
                      ::WHERE(_::{updated_at_ms}::LT(cutoff_ms))
  RETURN ended

QUERY ListFailedSessions(cutoff_ms: U64) =>
  failed <- N<Session>::WHERE(_::{status}::EQ("failed"))
                       ::WHERE(_::{updated_at_ms}::LT(cutoff_ms))
  RETURN failed

QUERY ListClosedTabs(cutoff_ms: U64) =>
  closed <- N<Tab>::WHERE(_::{status}::EQ("closed"))
                  ::WHERE(_::{closed_at_ms}::LT(cutoff_ms))
  RETURN closed
