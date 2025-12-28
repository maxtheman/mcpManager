// ============================================================================
// ADO + Playwright Session Manager - Unified HelixDB Schema
// ============================================================================
//
// This schema defines the unified graph data model for:
//
// PART 1: Playwright Browser Session Management
// - Pool management: Track browser instance providers (gateway processes)
// - Session isolation: Each agent gets dedicated BrowserContext
// - Tab management: Track pages within contexts with lifecycle states
// - Command audit: Full history of tool calls for debugging/replay
//
// PART 2: ADO (Agentic Development Orchestrator) Code Management
// - Repo: Named codebases tracked by ADO
// - Snapshot: Immutable content-addressed views of repo files (canonical state)
// - Proposal: Sets of edits relative to a base Snapshot (edit gate)
// - Validation: Deterministic validation runs with diagnostics and metrics
// - Dependency Graph: File-level import relationships for analysis
// - Design: Penpot design snapshots for frontend workflows
//
// Graph Structures:
//
//   Playwright:
//     Pool (browser provider)
//       └── Session (agent work unit)
//             └── Context (BrowserContext)
//                   └── Tab (Page)
//
//   ADO Code:
//     Repo (codebase)
//       ├── Snapshot (canonical state)
//       │     ├── File (content) ──Imports──► File
//       │     └── ValidationRun
//       │           ├── Diagnostic
//       │           └── Metric
//       └── Proposal (pending edits)
//             ├── FileEdit
//             └── ValidationRun
//
//   ADO Design:
//     Repo ──► DesignSnapshot (Penpot export)
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


// ############################################################################
// PART 2: ADO (Agentic Development Orchestrator) Schema
// ############################################################################

// ============================================================================
// ADO NODE TYPES
// ============================================================================

// Repo - a named codebase tracked by ADO
// This is the root entity for all code-related operations
N::Repo {
  INDEX repo_name: String,        // e.g. "mcpManager"
  root_path: String,              // absolute path to repo root
  created_at_ms: U64,
  updated_at_ms: U64,
  config_json: String,            // ado.config.json serialized
  head_snapshot_id: String,       // current canonical Snapshot ID ("" if none)
}

// Snapshot - an immutable, content-addressed view of repo files
// Represents the canonical "state of code" at a point in time
N::Snapshot {
  INDEX snapshot_key: String,     // content hash or unique key
  repo_name: String,              // denormalized for queries
  parent_snapshot_id: String,     // "" if root snapshot
  created_at_ms: U64,
  file_count: U32,
  total_bytes: U64,
  commit_sha: String,             // git commit if synced ("" if not)
  status: String,                 // "pending" | "complete" | "failed"
  metadata_json: String,          // arbitrary metadata
}

// File - represents a file's content within a Snapshot
// Content is stored by reference (sha256) for deduplication
N::File {
  INDEX file_key: String,         // "${snapshotId}:${path}"
  path: String,                   // relative path from repo root
  content: String,                // file content (may be large)
  sha256: String,                 // content hash for deduplication
  language: String,               // detected language e.g. "typescript"
  size_bytes: U64,
  line_count: U32,
  created_at_ms: U64,
}

// Proposal - a set of edits relative to a base Snapshot
// This is the "edit gate" - all changes must go through proposals
N::Proposal {
  INDEX proposal_key: String,     // unique proposal identifier
  repo_name: String,              // denormalized for queries
  base_snapshot_id: String,       // the Snapshot this proposal is based on
  status: String,                 // "draft" | "validating" | "valid" | "invalid" | "accepted" | "rejected"
  created_at_ms: U64,
  updated_at_ms: U64,
  created_by: String,             // agent or user who created it
  title: String,                  // human-readable title
  description: String,            // what this proposal does
  edit_count: U32,
  metadata_json: String,
}

// FileEdit - individual file edit within a Proposal
N::FileEdit {
  INDEX edit_key: String,         // "${proposalId}:${path}"
  path: String,                   // file path being edited
  kind: String,                   // "add" | "modify" | "delete" | "rename"
  content: String,                // new content (for add/modify)
  sha256: String,                 // content hash
  old_path: String,               // for rename operations
  created_at_ms: U64,
}

// ValidationRun - deterministic validation outputs for a Snapshot or Proposal
N::ValidationRun {
  INDEX validation_key: String,   // unique run identifier
  target_type: String,            // "snapshot" | "proposal"
  status: String,                 // "running" | "passed" | "failed" | "error"
  created_at_ms: U64,
  completed_at_ms: U64,           // 0 if running
  tool_versions_json: String,     // {"typescript": "5.x", ...}
  error_count: U32,
  warning_count: U32,
  metrics_json: String,           // summary metrics
}

// Diagnostic - a single diagnostic (error, warning, etc.) from validation
N::Diagnostic {
  INDEX diagnostic_key: String,   // "${validationId}:${seq}"
  path: String,                   // file path
  code: String,                   // diagnostic code e.g. "TS2322"
  category: String,               // "error" | "warning" | "suggestion" | "message"
  message: String,                // diagnostic message
  line: U32,
  column: U32,
  end_line: U32,
  end_column: U32,
  source: String,                 // e.g. "typescript" | "eslint" | "boundary-rule"
}

// Metric - a named metric from a ValidationRun
N::Metric {
  INDEX metric_key: String,       // "${validationId}:${name}"
  name: String,                   // e.g. "import_graph_density"
  value: F64,
  unit: String,                   // e.g. "ratio" | "count" | "ms"
  metadata_json: String,
}

// DesignSnapshot - Penpot design file export for deterministic design tracking
N::DesignSnapshot {
  INDEX design_key: String,       // "${repoName}:${penpotFileId}:${timestamp}"
  repo_name: String,
  penpot_file_id: String,         // Penpot file UUID
  penpot_project_id: String,      // Penpot project UUID
  created_at_ms: U64,
  file_name: String,              // original Penpot file name
  agentfs_path: String,           // path in AgentFS where .penpot is stored
  sha256: String,                 // hash of the .penpot bundle
  size_bytes: U64,
  metadata_json: String,
}

// ============================================================================
// ADO EDGE TYPES
// ============================================================================

// Repo owns Snapshots
E::RepoHasSnapshot {
  From: Repo,
  To: Snapshot,
  Properties: {
    created_at_ms: U64,
    is_head: Boolean,             // true if this is the current head
  }
}

// Snapshot contains Files
E::SnapshotHasFile {
  From: Snapshot,
  To: File,
  Properties: {
    created_at_ms: U64,
  }
}

// Repo owns Proposals
E::RepoHasProposal {
  From: Repo,
  To: Proposal,
  Properties: {
    created_at_ms: U64,
  }
}

// Proposal contains FileEdits
E::ProposalHasEdit {
  From: Proposal,
  To: FileEdit,
  Properties: {
    created_at_ms: U64,
    seq: U32,                     // order of edits
  }
}

// File imports another File (dependency graph)
// This tracks the import/export relationships between files
E::Imports {
  From: File,
  To: File,
  Properties: {
    specifier: String,            // the import specifier e.g. "./utils"
    kind: String,                 // "import" | "export" | "re-export" | "dynamic"
    is_type_only: Boolean,        // true if `import type`
  }
}

// Snapshot or Proposal has ValidationRun
E::HasValidation {
  From: Snapshot,
  To: ValidationRun,
  Properties: {
    created_at_ms: U64,
  }
}

// Note: HelixDB requires separate edge types for different From nodes
E::ProposalHasValidation {
  From: Proposal,
  To: ValidationRun,
  Properties: {
    created_at_ms: U64,
  }
}

// ValidationRun has Diagnostics
E::ValidationHasDiagnostic {
  From: ValidationRun,
  To: Diagnostic,
  Properties: {
    seq: U32,                     // order within validation
  }
}

// ValidationRun has Metrics
E::ValidationHasMetric {
  From: ValidationRun,
  To: Metric,
  Properties: {
    created_at_ms: U64,
  }
}

// Repo has DesignSnapshots
E::RepoHasDesign {
  From: Repo,
  To: DesignSnapshot,
  Properties: {
    created_at_ms: U64,
  }
}

// Proposal depends on another Proposal (proposal graph)
E::ProposalDependsOn {
  From: Proposal,
  To: Proposal,
  Properties: {
    kind: String,                 // "depends_on" | "conflicts_with" | "derived_from"
    created_at_ms: U64,
  }
}
