// ============================================================================
// Playwright Session Manager - HelixDB Schema
// ============================================================================
//
// This schema defines the graph data model for Playwright Browser Session Management:
// - Pool management: Track browser instance providers (gateway processes)
// - Session isolation: Each agent gets dedicated BrowserContext
// - Tab management: Track pages within contexts with lifecycle states
// - Command audit: Full history of tool calls for debugging/replay
//
// Graph Structures:
//
//   Playwright:
//     Pool (browser provider)
//       └── Session (agent work unit)
//             └── Context (BrowserContext)
//                   └── Tab (Page)
//
// ============================================================================

// ----------------------------------------------------------------------------
// NODE TYPES
// ----------------------------------------------------------------------------

// Pool - represents a browser instance provider (gateway process)
N::Pool {
  INDEX pool_key: String,         // e.g. "gateway@pid:1234"
  kind: String,                   // e.g. "playwright"
  created_at_ms: U64,
  last_heartbeat_at_ms: U64,
}

// Session - one agent's unit of work, owns exactly one BrowserContext
N::Session {
  INDEX session_key: String,      // e.g. "agent-7:task-123"
  pool_key: String,               // denormalized for queries
  owner_agent: String,            // e.g. "explore" / "oracle"
  status: String,                 // "starting" | "active" | "ending" | "ended" | "failed"
  created_at_ms: U64,
  updated_at_ms: U64,
  ttl_seconds: U32,
  expires_at_ms: U64,
  active_tab_id: String,          // Tab node ID ("" if none)
  metadata_json: String,          // arbitrary JSON blob
  last_error: String,             // "" if none
}

// Context - Playwright BrowserContext
N::Context {
  INDEX context_key: String,      // e.g. "${sessionId}:context"
  status: String,                 // "open" | "closed" | "orphaned"
  created_at_ms: U64,
  closed_at_ms: U64,              // 0 if open
  browser_type: String,           // "chromium" | "firefox" | "webkit"
  options_json: String,           // context creation options
}

// Tab - Playwright Page within a context
N::Tab {
  INDEX tab_key: String,          // e.g. "${sessionId}:tab:${n}"
  status: String,                 // "open" | "closed"
  created_at_ms: U64,
  closed_at_ms: U64,              // 0 if open
  last_seen_at_ms: U64,
  url: String,
  title: String,
  opener_tab_id: String,          // "" if none
  is_popup: Boolean,
}

// ----------------------------------------------------------------------------
// EDGE TYPES
// ----------------------------------------------------------------------------

// Pool owns Sessions
E::PoolHasSession {
  From: Pool,
  To: Session,
  Properties: {
    created_at_ms: U64,
  }
}

// Session owns Context (1:1 relationship)
E::SessionHasContext {
  From: Session,
  To: Context,
  Properties: {
    created_at_ms: U64,
  }
}

// Context owns Tabs (1:N relationship)
E::ContextHasTab {
  From: Context,
  To: Tab,
  Properties: {
    created_at_ms: U64,
    tab_index: U32,
  }
}

// Command history for audit trail
// Tracks every tool call made within a session for debugging and replay
E::SessionCommand {
  From: Session,
  To: Tab,
  Properties: {
    seq: U64,                     // sequence number within session
    tool: String,                 // tool name e.g. "browser_click"
    args_json: String,            // JSON-encoded arguments
    ok: Boolean,                  // true if succeeded
    started_at_ms: U64,
    duration_ms: U32,
    error: String,                // "" if ok=true
  }
}
