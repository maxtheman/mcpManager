/**
 * HelixDB client for Playwright session management.
 * Provides typed async functions wrapping Helix queries defined in helix/queries.hx.
 *
 * This client is the TypeScript interface to the Helix graph database,
 * providing type-safe access to all session management operations.
 *
 * Uses the official helix-ts SDK internally for all database operations.
 */

import { HelixDB } from "helix-ts";

// ============================================================================
// Configuration
// ============================================================================

export interface HelixClientOptions {
  endpoint: string;
  apiKey?: string;
}

// ============================================================================
// Result Types - Matching Helix node/edge structures
// ============================================================================

/** Pool record representing a browser pool */
export interface PoolRecord {
  id: string;
  pool_key: string;
  kind: string;
  created_at_ms?: number;
  last_heartbeat_at_ms?: number;
}

/** Session record representing a browser session */
export interface SessionRecord {
  id: string;
  session_key: string;
  pool_key: string;
  owner_agent: string;
  status: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  ttl_seconds?: number;
  expires_at_ms: number;
  active_tab_id?: string;
  metadata_json?: string;
  last_error?: string;
}

/** BrowserContext record */
export interface ContextRecord {
  id: string;
  context_key: string;
  status: string;
  created_at_ms?: number;
  closed_at_ms?: number;
  browser_type?: string;
  options_json?: string;
}

/** Tab/Page record */
export interface TabRecord {
  id: string;
  tab_key: string;
  status: string;
  created_at_ms?: number;
  closed_at_ms?: number;
  last_seen_at_ms?: number;
  url: string;
  title: string;
  opener_tab_id?: string;
  is_popup?: boolean;
}

/** Command audit record (edge from Session to Tab) */
export interface CommandRecord {
  seq: number;
  tool: string;
  args_json?: string;
  ok: boolean;
  started_at_ms: number;
  duration_ms: number;
  error?: string;
}

// ============================================================================
// Partial types for query responses (some queries return subset of fields)
// ============================================================================

/** Partial pool for create/update responses */
export interface PoolCreateResult {
  id: string;
  pool_key: string;
  kind: string;
}

/** Partial session for create responses */
export interface SessionCreateResult {
  id: string;
  session_key: string;
  status: string;
  expires_at_ms: number;
}

/** Partial session for status update responses */
export interface SessionStatusResult {
  id: string;
  status: string;
  updated_at_ms?: number;
}

/** Partial context for create responses */
export interface ContextCreateResult {
  id: string;
  context_key: string;
  status: string;
}

/** Partial tab for create responses */
export interface TabCreateResult {
  id: string;
  tab_key: string;
  status: string;
}

/** Partial command for record responses */
export interface CommandCreateResult {
  seq: number;
  tool: string;
  ok: boolean;
}

// ============================================================================
// ADO Result Types - Matching Helix node/edge structures
// ============================================================================

/** Repo record representing a codebase tracked by ADO */
export interface RepoRecord {
  id: string;
  repo_name: string;
  root_path: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  config_json?: string;
  head_snapshot_id?: string;
}

/** Snapshot record representing an immutable view of repo files */
export interface SnapshotRecord {
  id: string;
  snapshot_key: string;
  repo_name: string;
  parent_snapshot_id?: string;
  created_at_ms?: number;
  file_count: number;
  total_bytes: number;
  commit_sha?: string;
  status: string;
  metadata_json?: string;
}

/** File record representing a file's content within a Snapshot */
export interface FileRecord {
  id: string;
  file_key: string;
  path: string;
  content?: string;
  sha256: string;
  language: string;
  size_bytes: number;
  line_count?: number;
  created_at_ms?: number;
}

/** Proposal record representing a set of edits relative to a base Snapshot */
export interface ProposalRecord {
  id: string;
  proposal_key: string;
  repo_name: string;
  base_snapshot_id: string;
  status: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  created_by: string;
  title: string;
  description?: string;
  edit_count: number;
  metadata_json?: string;
}

/** FileEdit record representing an individual file edit within a Proposal */
export interface FileEditRecord {
  id: string;
  edit_key: string;
  path: string;
  kind: string;
  content?: string;
  sha256?: string;
  old_path?: string;
  created_at_ms?: number;
}

/** ValidationRun record representing a validation execution */
export interface ValidationRunRecord {
  id: string;
  validation_key: string;
  target_type: string;
  status: string;
  created_at_ms?: number;
  completed_at_ms?: number;
  tool_versions_json?: string;
  error_count: number;
  warning_count: number;
  metrics_json?: string;
}

/** Diagnostic record representing a single diagnostic from validation */
export interface DiagnosticRecord {
  id: string;
  diagnostic_key: string;
  path: string;
  code: string;
  category: string;
  message: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
  source: string;
}

/** Metric record representing a named metric from a ValidationRun */
export interface MetricRecord {
  id: string;
  metric_key: string;
  name: string;
  value: number;
  unit: string;
  metadata_json?: string;
}

/** DesignSnapshot record representing a Penpot design file export */
export interface DesignSnapshotRecord {
  id: string;
  design_key: string;
  repo_name: string;
  penpot_file_id: string;
  penpot_project_id?: string;
  created_at_ms?: number;
  file_name: string;
  agentfs_path: string;
  sha256: string;
  size_bytes: number;
  metadata_json?: string;
}

/** Import edge record representing file dependencies */
export interface ImportEdgeRecord {
  specifier: string;
  kind: string;
  is_type_only: boolean;
}

// ============================================================================
// ADO Partial types for query responses
// ============================================================================

/** Partial repo for create responses */
export interface RepoCreateResult {
  id: string;
  repo_name: string;
  root_path: string;
}

/** Partial snapshot for create responses */
export interface SnapshotCreateResult {
  id: string;
  snapshot_key: string;
  status: string;
}

/** Partial file for create responses */
export interface FileCreateResult {
  id: string;
  file_key: string;
  path: string;
  sha256: string;
}

/** Partial proposal for create responses */
export interface ProposalCreateResult {
  id: string;
  proposal_key: string;
  status: string;
}

/** Partial file edit for create responses */
export interface FileEditCreateResult {
  id: string;
  edit_key: string;
  path: string;
  kind: string;
}

/** Partial validation run for create responses */
export interface ValidationRunCreateResult {
  id: string;
  validation_key: string;
  status: string;
}

/** Partial diagnostic for create responses */
export interface DiagnosticCreateResult {
  id: string;
  diagnostic_key: string;
  category: string;
  code: string;
}

/** Partial metric for create responses */
export interface MetricCreateResult {
  id: string;
  metric_key: string;
  name: string;
  value: number;
}

/** Partial design snapshot for create responses */
export interface DesignSnapshotCreateResult {
  id: string;
  design_key: string;
  file_name: string;
}

// ============================================================================
// HelixClient Class
// ============================================================================

/**
 * Client for interacting with the Helix graph database.
 * Provides typed methods for all Playwright session management queries.
 */
export class HelixClient {
  private sdk: HelixDB;
  private endpoint: string;

  constructor(options: HelixClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.sdk = new HelixDB(this.endpoint, options.apiKey ?? null);
  }

  private async query<T>(
    name: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      const result = await this.sdk.query(name, params);
      // SDK wraps results in an object like { pool: {...} } or { pools: [...] }
      // Unwrap by extracting the first (and only) value from the result object
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const keys = Object.keys(result);
        if (keys.length === 1) {
          return (result as Record<string, unknown>)[keys[0]] as T;
        }
      }
      return result as T;
    } catch (error) {
      throw new Error(
        `Helix query ${name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ==========================================================================
  // 1. POOL CRUD
  // ==========================================================================

  /**
   * Create a new pool record.
   * @param params - Pool creation parameters
   * @returns Created pool record
   */
  async createPool(params: {
    pool_key: string;
    kind: string;
    now_ms: number;
  }): Promise<PoolCreateResult> {
    return this.query("CreatePool", params);
  }

  /**
   * Get a pool by its unique key.
   * @param pool_key - Pool key
   * @returns Pool record or null if not found
   */
  async getPoolByKey(pool_key: string): Promise<PoolRecord | null> {
    try {
      return await this.query("GetPoolByKey", { pool_key });
    } catch {
      return null;
    }
  }

  /**
   * Get a pool by its ID.
   * @param pool_id - Pool ID
   * @returns Pool record or null if not found
   */
  async getPool(pool_id: string): Promise<PoolRecord | null> {
    try {
      return await this.query("GetPool", { pool_id });
    } catch {
      return null;
    }
  }

  /**
   * Update a pool's heartbeat timestamp.
   * @param params - Pool ID and current timestamp
   * @returns Updated pool record
   */
  async updatePoolHeartbeat(params: {
    pool_id: string;
    now_ms: number;
  }): Promise<{ id: string; last_heartbeat_at_ms: number }> {
    return this.query("UpdatePoolHeartbeat", params);
  }

  /**
   * Delete a pool by ID.
   * @param pool_id - Pool ID
   */
  async deletePool(pool_id: string): Promise<void> {
    await this.query("DeletePool", { pool_id });
  }

  // ==========================================================================
  // 2. SESSION CRUD
  // ==========================================================================

  /**
   * Create a new session linked to a pool.
   * @param params - Session creation parameters
   * @returns Created session record
   */
  async createSession(params: {
    pool_id: string;
    pool_key: string;
    session_key: string;
    owner_agent: string;
    ttl_seconds: number;
    expires_at_ms: number;
    now_ms: number;
    metadata_json: string;
  }): Promise<SessionCreateResult> {
    return this.query("CreateSession", params);
  }

  /**
   * Get a session by its ID.
   * @param session_id - Session ID
   * @returns Full session record or null if not found
   */
  async getSession(session_id: string): Promise<SessionRecord | null> {
    try {
      return await this.query("GetSession", { session_id });
    } catch {
      return null;
    }
  }

  /**
   * Get a session by its unique key.
   * @param session_key - Session key
   * @returns Partial session record or null if not found
   */
  async getSessionByKey(
    session_key: string
  ): Promise<Pick<
    SessionRecord,
    | "id"
    | "session_key"
    | "pool_key"
    | "owner_agent"
    | "status"
    | "expires_at_ms"
    | "active_tab_id"
  > | null> {
    try {
      return await this.query("GetSessionByKey", { session_key });
    } catch {
      return null;
    }
  }

  /**
   * Update session status.
   * @param params - Session ID, new status, and timestamp
   * @returns Updated session status
   */
  async updateSessionStatus(params: {
    session_id: string;
    status: string;
    now_ms: number;
  }): Promise<SessionStatusResult> {
    return this.query("UpdateSessionStatus", params);
  }

  /**
   * Update session's active tab.
   * @param params - Session ID, tab ID, and timestamp
   * @returns Updated session record
   */
  async updateSessionActiveTab(params: {
    session_id: string;
    tab_id: string;
    now_ms: number;
  }): Promise<{ id: string; active_tab_id: string }> {
    return this.query("UpdateSessionActiveTab", params);
  }

  /**
   * Record an error on a session and mark it as failed.
   * @param params - Session ID, error message, status, and timestamp
   * @returns Updated session record
   */
  async updateSessionError(params: {
    session_id: string;
    error: string;
    status?: string;
    now_ms: number;
  }): Promise<{ id: string; status: string; last_error: string }> {
    return this.query("UpdateSessionError", {
      ...params,
      status: params.status ?? "failed",
    });
  }

  /**
   * Extend session TTL.
   * @param params - Session ID, new expiration time, and timestamp
   * @returns Updated session record
   */
  async extendSessionTTL(params: {
    session_id: string;
    new_expires_at_ms: number;
    now_ms: number;
  }): Promise<{ id: string; expires_at_ms: number }> {
    return this.query("ExtendSessionTTL", params);
  }

  /**
   * End a session (mark as ended).
   * @param params - Session ID, optional status, and timestamp
   * @returns Updated session record
   */
  async endSession(params: {
    session_id: string;
    status?: string;
    now_ms: number;
  }): Promise<{ id: string; status: string }> {
    return this.query("EndSession", {
      ...params,
      status: params.status ?? "ended",
    });
  }

  /**
   * Delete a session permanently.
   * @param session_id - Session ID
   */
  async deleteSession(session_id: string): Promise<void> {
    await this.query("DeleteSession", { session_id });
  }

  // ==========================================================================
  // 3. CONTEXT CRUD
  // ==========================================================================

  /**
   * Create a new browser context linked to a session.
   * @param params - Context creation parameters
   * @returns Created context record
   */
  async createContext(params: {
    session_id: string;
    context_key: string;
    now_ms: number;
    browser_type: string;
    options_json: string;
  }): Promise<ContextCreateResult> {
    return this.query("CreateContext", params);
  }

  /**
   * Get a context by ID.
   * @param context_id - Context ID
   * @returns Full context record or null if not found
   */
  async getContext(context_id: string): Promise<ContextRecord | null> {
    try {
      return await this.query("GetContext", { context_id });
    } catch {
      return null;
    }
  }

  /**
   * Get a context by its unique key.
   * @param context_key - Context key
   * @returns Partial context record or null if not found
   */
  async getContextByKey(
    context_key: string
  ): Promise<Pick<
    ContextRecord,
    "id" | "context_key" | "status"
  > | null> {
    try {
      return await this.query("GetContextByKey", { context_key });
    } catch {
      return null;
    }
  }

  /**
   * Get the context for a session (via SessionHasContext edge).
   * @param session_id - Session ID
   * @returns Context record or null if not found
   */
  async getSessionContext(
    session_id: string
  ): Promise<Pick<
    ContextRecord,
    "id" | "context_key" | "status" | "browser_type"
  > | null> {
    try {
      return await this.query("GetSessionContext", { session_id });
    } catch {
      return null;
    }
  }

  /**
   * Close a context.
   * @param params - Context ID, optional status, and timestamp
   * @returns Updated context record
   */
  async closeContext(params: {
    context_id: string;
    status?: string;
    now_ms: number;
  }): Promise<{ id: string; status: string; closed_at_ms: number }> {
    return this.query("CloseContext", {
      ...params,
      status: params.status ?? "closed",
    });
  }

  /**
   * Mark a context as orphaned.
   * @param params - Context ID, optional status, and timestamp
   * @returns Updated context record
   */
  async markContextOrphaned(params: {
    context_id: string;
    status?: string;
    now_ms: number;
  }): Promise<{ id: string; status: string }> {
    return this.query("MarkContextOrphaned", {
      ...params,
      status: params.status ?? "orphaned",
    });
  }

  /**
   * Delete a context permanently.
   * @param context_id - Context ID
   */
  async deleteContext(context_id: string): Promise<void> {
    await this.query("DeleteContext", { context_id });
  }

  // ==========================================================================
  // 4. TAB CRUD
  // ==========================================================================

  /**
   * Add a new tab to a context.
   * @param params - Tab creation parameters
   * @returns Created tab record
   */
  async addTab(params: {
    context_id: string;
    tab_key: string;
    opener_tab_id: string;
    is_popup: boolean;
    now_ms: number;
    tab_index: number;
    url: string;
    title: string;
  }): Promise<TabCreateResult> {
    return this.query("AddTab", params);
  }

  /**
   * Get a tab by ID.
   * @param tab_id - Tab ID
   * @returns Full tab record or null if not found
   */
  async getTab(tab_id: string): Promise<TabRecord | null> {
    try {
      return await this.query("GetTab", { tab_id });
    } catch {
      return null;
    }
  }

  /**
   * Get a tab by its unique key.
   * @param tab_key - Tab key
   * @returns Partial tab record or null if not found
   */
  async getTabByKey(
    tab_key: string
  ): Promise<Pick<
    TabRecord,
    "id" | "tab_key" | "status" | "url"
  > | null> {
    try {
      return await this.query("GetTabByKey", { tab_key });
    } catch {
      return null;
    }
  }

  /**
   * Update tab URL and title.
   * @param params - Tab ID, new URL, title, and timestamp
   * @returns Updated tab record
   */
  async updateTabUrl(params: {
    tab_id: string;
    url: string;
    title: string;
    now_ms: number;
  }): Promise<{ id: string; url: string; title: string }> {
    return this.query("UpdateTabUrl", params);
  }

  /**
   * Update tab last seen timestamp.
   * @param params - Tab ID and timestamp
   * @returns Updated tab record
   */
  async updateTabLastSeen(params: {
    tab_id: string;
    now_ms: number;
  }): Promise<{ id: string; last_seen_at_ms: number }> {
    return this.query("UpdateTabLastSeen", params);
  }

  /**
   * Close a tab.
   * @param params - Tab ID, optional status, and timestamp
   * @returns Updated tab record
   */
  async closeTab(params: {
    tab_id: string;
    status?: string;
    now_ms: number;
  }): Promise<{ id: string; status: string; closed_at_ms: number }> {
    return this.query("CloseTab", {
      ...params,
      status: params.status ?? "closed",
    });
  }

  /**
   * Delete a tab permanently.
   * @param tab_id - Tab ID
   */
  async deleteTab(tab_id: string): Promise<void> {
    await this.query("DeleteTab", { tab_id });
  }

  // ==========================================================================
  // 5. COMMAND AUDIT
  // ==========================================================================

  /**
   * Record a command execution (creates edge from Session to Tab).
   * @param params - Command parameters
   * @returns Created command record
   */
  async recordCommand(params: {
    session_id: string;
    tab_id: string;
    seq: number;
    tool: string;
    args_json: string;
    ok: boolean;
    started_at_ms: number;
    duration_ms: number;
    error: string;
  }): Promise<CommandCreateResult> {
    return this.query("RecordCommand", params);
  }

  /**
   * Get all commands for a session.
   * @param session_id - Session ID
   * @returns Array of command records
   */
  async getSessionCommands(session_id: string): Promise<CommandRecord[]> {
    try {
      return await this.query("GetSessionCommands", { session_id });
    } catch {
      return [];
    }
  }

  /**
   * Get all commands targeting a specific tab.
   * @param tab_id - Tab ID
   * @returns Array of command records
   */
  async getTabCommands(tab_id: string): Promise<CommandRecord[]> {
    try {
      return await this.query("GetTabCommands", { tab_id });
    } catch {
      return [];
    }
  }

  /**
   * Get failed commands for a session.
   * @param session_id - Session ID
   * @returns Array of failed command records
   */
  async getFailedCommands(
    session_id: string
  ): Promise<Pick<CommandRecord, "seq" | "tool" | "error" | "started_at_ms">[]> {
    try {
      return await this.query("GetFailedCommands", { session_id });
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // 6. INTROSPECTION QUERIES
  // ==========================================================================

  /**
   * List all pools.
   * @returns Array of pool records
   */
  async listPools(): Promise<PoolRecord[]> {
    try {
      return await this.query("ListPools", {});
    } catch {
      return [];
    }
  }

  /**
   * List all sessions for a pool.
   * @param pool_id - Pool ID
   * @returns Array of session records
   */
  async listPoolSessions(
    pool_id: string
  ): Promise<
    Pick<
      SessionRecord,
      "id" | "session_key" | "owner_agent" | "status" | "expires_at_ms"
    >[]
  > {
    try {
      return await this.query("ListPoolSessions", { pool_id });
    } catch {
      return [];
    }
  }

  /**
   * List all sessions owned by a specific agent.
   * @param owner_agent - Owner agent identifier
   * @returns Array of session records
   */
  async listSessionsByOwner(
    owner_agent: string
  ): Promise<
    Pick<
      SessionRecord,
      "id" | "session_key" | "status" | "pool_key" | "expires_at_ms"
    >[]
  > {
    try {
      return await this.query("ListSessionsByOwner", { owner_agent });
    } catch {
      return [];
    }
  }

  /**
   * List all sessions with a specific status.
   * @param status - Session status
   * @returns Array of session records
   */
  async listSessionsByStatus(
    status: string
  ): Promise<
    Pick<SessionRecord, "id" | "session_key" | "owner_agent" | "expires_at_ms">[]
  > {
    try {
      return await this.query("ListSessionsByStatus", { status });
    } catch {
      return [];
    }
  }

  /**
   * List all tabs for a session (via Session -> Context -> Tab).
   * @param session_id - Session ID
   * @returns Array of tab records
   */
  async listSessionTabs(
    session_id: string
  ): Promise<
    Pick<TabRecord, "id" | "tab_key" | "status" | "url" | "title" | "is_popup">[]
  > {
    try {
      return await this.query("ListSessionTabs", { session_id });
    } catch {
      return [];
    }
  }

  /**
   * List all tabs for a context.
   * @param context_id - Context ID
   * @returns Array of tab records
   */
  async listContextTabs(
    context_id: string
  ): Promise<Pick<TabRecord, "id" | "tab_key" | "status" | "url" | "title">[]> {
    try {
      return await this.query("ListContextTabs", { context_id });
    } catch {
      return [];
    }
  }

  /**
   * List only open tabs for a context.
   * @param context_id - Context ID
   * @returns Array of open tab records
   */
  async listOpenTabs(
    context_id: string
  ): Promise<Pick<TabRecord, "id" | "tab_key" | "url" | "title">[]> {
    try {
      return await this.query("ListOpenTabs", { context_id });
    } catch {
      return [];
    }
  }

  /**
   * Count total sessions in a pool.
   * @param pool_id - Pool ID
   * @returns Session count
   */
  async countPoolSessions(pool_id: string): Promise<number> {
    try {
      return await this.query("CountPoolSessions", { pool_id });
    } catch {
      return 0;
    }
  }

  /**
   * Count active sessions in a pool.
   * @param pool_id - Pool ID
   * @returns Active session count
   */
  async countActiveSessions(pool_id: string): Promise<number> {
    try {
      return await this.query("CountActiveSessions", { pool_id });
    } catch {
      return 0;
    }
  }

  // ==========================================================================
  // 7. JANITOR QUERIES
  // ==========================================================================

  /**
   * List expired sessions that need cleanup.
   * @param now_ms - Current timestamp in milliseconds
   * @returns Array of expired session records
   */
  async listExpiredSessions(
    now_ms: number
  ): Promise<
    Pick<
      SessionRecord,
      "id" | "session_key" | "status" | "expires_at_ms" | "pool_key"
    >[]
  > {
    try {
      return await this.query("ListExpiredSessions", { now_ms });
    } catch {
      return [];
    }
  }

  /**
   * List orphaned contexts.
   * @returns Array of orphaned context records
   */
  async listOrphanedContexts(): Promise<
    Pick<ContextRecord, "id" | "context_key" | "status">[]
  > {
    try {
      return await this.query("ListOrphanedContexts", {});
    } catch {
      return [];
    }
  }

  /**
   * List pools that haven't sent a heartbeat since cutoff.
   * @param cutoff_ms - Cutoff timestamp in milliseconds
   * @returns Array of stale pool records
   */
  async listStalePools(
    cutoff_ms: number
  ): Promise<Pick<PoolRecord, "id" | "pool_key" | "last_heartbeat_at_ms">[]> {
    try {
      return await this.query("ListStalePools", { cutoff_ms });
    } catch {
      return [];
    }
  }

  /**
   * List ended sessions that can be garbage collected.
   * @param cutoff_ms - Cutoff timestamp in milliseconds
   * @returns Array of ended session records
   */
  async listEndedSessions(
    cutoff_ms: number
  ): Promise<Pick<SessionRecord, "id" | "session_key" | "updated_at_ms">[]> {
    try {
      return await this.query("ListEndedSessions", { cutoff_ms });
    } catch {
      return [];
    }
  }

  /**
   * List failed sessions that can be garbage collected.
   * @param cutoff_ms - Cutoff timestamp in milliseconds
   * @returns Array of failed session records
   */
  async listFailedSessions(
    cutoff_ms: number
  ): Promise<Pick<SessionRecord, "id" | "session_key" | "last_error">[]> {
    try {
      return await this.query("ListFailedSessions", { cutoff_ms });
    } catch {
      return [];
    }
  }

  /**
   * List closed tabs that can be garbage collected.
   * @param cutoff_ms - Cutoff timestamp in milliseconds
   * @returns Array of closed tab records
   */
  async listClosedTabs(
    cutoff_ms: number
  ): Promise<Pick<TabRecord, "id" | "tab_key" | "status">[]> {
    try {
      return await this.query("ListClosedTabs", { cutoff_ms });
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  // ##########################################################################
  // PART 2: ADO (Agentic Development Orchestrator) Methods
  // ##########################################################################

  // ==========================================================================
  // 8. REPO CRUD
  // ==========================================================================

  async createRepo(params: {
    repo_name: string;
    root_path: string;
    config_json: string;
    now_ms: number;
  }): Promise<RepoCreateResult> {
    return this.query("CreateRepo", params);
  }

  async getRepoByName(repo_name: string): Promise<RepoRecord | null> {
    try {
      return await this.query("GetRepoByName", { repo_name });
    } catch {
      return null;
    }
  }

  async getRepo(repo_id: string): Promise<Pick<RepoRecord, "id" | "repo_name" | "root_path" | "head_snapshot_id"> | null> {
    try {
      return await this.query("GetRepo", { repo_id });
    } catch {
      return null;
    }
  }

  async updateRepoHead(params: {
    repo_id: string;
    head_snapshot_id: string;
    now_ms: number;
  }): Promise<{ id: string; head_snapshot_id: string }> {
    return this.query("UpdateRepoHead", params);
  }

  async updateRepoConfig(params: {
    repo_id: string;
    config_json: string;
    now_ms: number;
  }): Promise<{ id: string; updated_at_ms: number }> {
    return this.query("UpdateRepoConfig", params);
  }

  async listRepos(): Promise<Pick<RepoRecord, "id" | "repo_name" | "root_path" | "head_snapshot_id">[]> {
    try {
      return await this.query("ListRepos", {});
    } catch {
      return [];
    }
  }

  async deleteRepo(repo_id: string): Promise<void> {
    await this.query("DeleteRepo", { repo_id });
  }

  // ==========================================================================
  // 9. SNAPSHOT CRUD
  // ==========================================================================

  async createSnapshot(params: {
    repo_id: string;
    snapshot_key: string;
    repo_name: string;
    parent_snapshot_id: string;
    commit_sha: string;
    now_ms: number;
    metadata_json: string;
  }): Promise<SnapshotCreateResult> {
    return this.query("CreateSnapshot", params);
  }

  async getSnapshot(snapshot_id: string): Promise<SnapshotRecord | null> {
    try {
      return await this.query("GetSnapshot", { snapshot_id });
    } catch {
      return null;
    }
  }

  async getSnapshotByKey(snapshot_key: string): Promise<{
    snapshot_key: string;
    repo_name: string;
    parent_snapshot_id: string;
    created_at_ms: number;
    file_count: number;
    total_bytes: number;
    commit_sha: string;
    status: string;
    metadata_json: string;
  } | null> {
    try {
      return await this.query("GetSnapshotByKey", { snapshot_key });
    } catch {
      return null;
    }
  }

  async updateSnapshotStatus(params: {
    snapshot_id: string;
    status: string;
    file_count: number;
    total_bytes: number;
  }): Promise<{ id: string; status: string; file_count: number }> {
    return this.query("UpdateSnapshotStatus", params);
  }

  async listRepoSnapshots(repo_id: string): Promise<Pick<SnapshotRecord, "id" | "snapshot_key" | "status" | "created_at_ms" | "file_count" | "commit_sha">[]> {
    try {
      return await this.query("ListRepoSnapshots", { repo_id });
    } catch {
      return [];
    }
  }

  async deleteSnapshot(snapshot_id: string): Promise<void> {
    await this.query("DeleteSnapshot", { snapshot_id });
  }

  // ==========================================================================
  // 10. FILE CRUD
  // ==========================================================================

  async createFile(params: {
    snapshot_id: string;
    file_key: string;
    path: string;
    content: string;
    sha256: string;
    language: string;
    size_bytes: number;
    line_count: number;
    now_ms: number;
  }): Promise<FileCreateResult> {
    return this.query("CreateFile", params);
  }

  async getFile(file_id: string): Promise<FileRecord | null> {
    try {
      return await this.query("GetFile", { file_id });
    } catch {
      return null;
    }
  }

  async getFileByKey(file_key: string): Promise<Pick<FileRecord, "id" | "file_key" | "path" | "sha256" | "language"> | null> {
    try {
      return await this.query("GetFileByKey", { file_key });
    } catch {
      return null;
    }
  }

  async getSnapshotFiles(snapshot_id: string): Promise<Pick<FileRecord, "id" | "file_key" | "path" | "sha256" | "language" | "size_bytes">[]> {
    try {
      return await this.query("GetSnapshotFiles", { snapshot_id });
    } catch {
      return [];
    }
  }

  async getFileContent(file_id: string): Promise<{ id: string; path: string; content: string } | null> {
    try {
      return await this.query("GetFileContent", { file_id });
    } catch {
      return null;
    }
  }

  async deleteFile(file_id: string): Promise<void> {
    await this.query("DeleteFile", { file_id });
  }

  // ==========================================================================
  // 11. PROPOSAL CRUD
  // ==========================================================================

  async createProposal(params: {
    repo_id: string;
    proposal_key: string;
    repo_name: string;
    base_snapshot_id: string;
    created_by: string;
    title: string;
    description: string;
    now_ms: number;
    metadata_json: string;
  }): Promise<ProposalCreateResult> {
    return this.query("CreateProposal", params);
  }

  async getProposal(proposal_id: string): Promise<ProposalRecord | null> {
    try {
      return await this.query("GetProposal", { proposal_id });
    } catch {
      return null;
    }
  }

  async getProposalByKey(proposal_key: string): Promise<{
    id: string;
    proposal_key: string;
    repo_name: string;
    base_snapshot_id: string;
    status: string;
    created_at_ms: number;
    updated_at_ms: number;
    created_by: string;
    title: string;
    description: string;
    edit_count: number;
    metadata_json: string;
  } | null> {
    try {
      const result = await this.query("GetProposalByKey", { proposal_key });
      if (!result || typeof result !== "object" || Object.keys(result).length === 0) {
        return null;
      }
      return result as {
        id: string;
        proposal_key: string;
        repo_name: string;
        base_snapshot_id: string;
        status: string;
        created_at_ms: number;
        updated_at_ms: number;
        created_by: string;
        title: string;
        description: string;
        edit_count: number;
        metadata_json: string;
      };
    } catch {
      return null;
    }
  }

  async updateProposalStatus(params: {
    proposal_id: string;
    status: string;
    now_ms: number;
  }): Promise<{ id: string; status: string }> {
    return this.query("UpdateProposalStatus", params);
  }

  async updateProposalEditCount(params: {
    proposal_id: string;
    edit_count: number;
    now_ms: number;
  }): Promise<{ id: string; edit_count: number }> {
    return this.query("UpdateProposalEditCount", params);
  }

  async listRepoProposals(repo_id: string): Promise<Pick<ProposalRecord, "id" | "proposal_key" | "status" | "title" | "created_by" | "created_at_ms" | "edit_count">[]> {
    try {
      const result = await this.query("ListRepoProposals", { repo_id });
      if (!result || typeof result !== "object") return [];
      if (Array.isArray(result)) return result;
      if (Object.keys(result).length === 0) return [];
      return [result] as Pick<ProposalRecord, "id" | "proposal_key" | "status" | "title" | "created_by" | "created_at_ms" | "edit_count">[];
    } catch {
      return [];
    }
  }

  async listProposalsByStatus(status: string): Promise<Pick<ProposalRecord, "id" | "proposal_key" | "repo_name" | "title" | "created_at_ms">[]> {
    try {
      return await this.query("ListProposalsByStatus", { status });
    } catch {
      return [];
    }
  }

  async deleteProposal(proposal_id: string): Promise<void> {
    await this.query("DeleteProposal", { proposal_id });
  }

  // ==========================================================================
  // 12. FILE EDIT CRUD
  // ==========================================================================

  async createFileEdit(params: {
    proposal_id: string;
    edit_key: string;
    path: string;
    kind: string;
    content: string;
    sha256: string;
    old_path: string;
    now_ms: number;
    seq: number;
  }): Promise<FileEditCreateResult> {
    return this.query("CreateFileEdit", params);
  }

  async getFileEdit(edit_id: string): Promise<FileEditRecord | null> {
    try {
      const result = await this.query("GetFileEdit", { edit_id });
      if (!result || typeof result !== "object") return null;
      if (Object.keys(result).length === 0) return null;
      return result as FileEditRecord;
    } catch {
      return null;
    }
  }

  async getProposalEdits(proposal_id: string): Promise<Pick<FileEditRecord, "id" | "edit_key" | "path" | "kind" | "sha256">[]> {
    try {
      const result = await this.query("GetProposalEdits", { proposal_id });
      if (!result || typeof result !== "object") return [];
      if (Array.isArray(result)) return result;
      if (Object.keys(result).length === 0) return [];
      return [result] as Pick<FileEditRecord, "id" | "edit_key" | "path" | "kind" | "sha256">[];
    } catch {
      return [];
    }
  }

  async deleteFileEdit(edit_id: string): Promise<void> {
    await this.query("DeleteFileEdit", { edit_id });
  }

  // ==========================================================================
  // 13. VALIDATION RUN CRUD
  // ==========================================================================

  async createValidationRun(params: {
    target_id: string;
    target_type: string;
    validation_key: string;
    tool_versions_json: string;
    now_ms: number;
  }): Promise<ValidationRunCreateResult> {
    return this.query("CreateValidationRun", params);
  }

  async linkValidationToSnapshot(params: {
    snapshot_id: string;
    validation_id: string;
    now_ms: number;
  }): Promise<{ created_at_ms: number }> {
    return this.query("LinkValidationToSnapshot", params);
  }

  async linkValidationToProposal(params: {
    proposal_id: string;
    validation_id: string;
    now_ms: number;
  }): Promise<{ created_at_ms: number }> {
    return this.query("LinkValidationToProposal", params);
  }

  async getValidationRun(validation_id: string): Promise<ValidationRunRecord | null> {
    try {
      return await this.query("GetValidationRun", { validation_id });
    } catch {
      return null;
    }
  }

  async updateValidationStatus(params: {
    validation_id: string;
    status: string;
    error_count: number;
    warning_count: number;
    metrics_json: string;
    completed_at_ms: number;
  }): Promise<{ id: string; status: string; error_count: number }> {
    return this.query("UpdateValidationStatus", params);
  }

  async getSnapshotValidations(snapshot_id: string): Promise<Pick<ValidationRunRecord, "id" | "validation_key" | "status" | "error_count" | "warning_count" | "created_at_ms">[]> {
    try {
      return await this.query("GetSnapshotValidations", { snapshot_id });
    } catch {
      return [];
    }
  }

  async getProposalValidations(proposal_id: string): Promise<Pick<ValidationRunRecord, "id" | "validation_key" | "status" | "error_count" | "warning_count" | "created_at_ms">[]> {
    try {
      return await this.query("GetProposalValidations", { proposal_id });
    } catch {
      return [];
    }
  }

  async deleteValidationRun(validation_id: string): Promise<void> {
    await this.query("DeleteValidationRun", { validation_id });
  }

  // ==========================================================================
  // 14. DIAGNOSTIC CRUD
  // ==========================================================================

  async createDiagnostic(params: {
    validation_id: string;
    diagnostic_key: string;
    path: string;
    code: string;
    category: string;
    message: string;
    line: number;
    column: number;
    end_line: number;
    end_column: number;
    source: string;
    seq: number;
  }): Promise<DiagnosticCreateResult> {
    return this.query("CreateDiagnostic", params);
  }

  async getValidationDiagnostics(validation_id: string): Promise<Pick<DiagnosticRecord, "id" | "diagnostic_key" | "path" | "code" | "category" | "message" | "line" | "column" | "source">[]> {
    try {
      return await this.query("GetValidationDiagnostics", { validation_id });
    } catch {
      return [];
    }
  }

  async getDiagnosticsByCategory(params: {
    validation_id: string;
    category: string;
  }): Promise<Pick<DiagnosticRecord, "id" | "path" | "code" | "message" | "line">[]> {
    try {
      return await this.query("GetDiagnosticsByCategory", params);
    } catch {
      return [];
    }
  }

  async deleteDiagnostic(diagnostic_id: string): Promise<void> {
    await this.query("DeleteDiagnostic", { diagnostic_id });
  }

  // ==========================================================================
  // 15. METRIC CRUD
  // ==========================================================================

  async createMetric(params: {
    validation_id: string;
    metric_key: string;
    name: string;
    value: number;
    unit: string;
    metadata_json: string;
    now_ms: number;
  }): Promise<MetricCreateResult> {
    return this.query("CreateMetric", params);
  }

  async getValidationMetrics(validation_id: string): Promise<Pick<MetricRecord, "id" | "metric_key" | "name" | "value" | "unit" | "metadata_json">[]> {
    try {
      return await this.query("GetValidationMetrics", { validation_id });
    } catch {
      return [];
    }
  }

  async getMetricByName(params: {
    validation_id: string;
    name: string;
  }): Promise<Pick<MetricRecord, "id" | "name" | "value" | "unit">[]> {
    try {
      return await this.query("GetMetricByName", params);
    } catch {
      return [];
    }
  }

  async deleteMetric(metric_id: string): Promise<void> {
    await this.query("DeleteMetric", { metric_id });
  }

  // ==========================================================================
  // 16. IMPORT GRAPH QUERIES
  // ==========================================================================

  async createImport(params: {
    from_file_id: string;
    to_file_id: string;
    specifier: string;
    kind: string;
    is_type_only: boolean;
  }): Promise<{ specifier: string; kind: string }> {
    return this.query("CreateImport", params);
  }

  async getFileImports(file_id: string): Promise<Pick<FileRecord, "id" | "path" | "language">[]> {
    try {
      return await this.query("GetFileImports", { file_id });
    } catch {
      return [];
    }
  }

  async getFileImporters(file_id: string): Promise<Pick<FileRecord, "id" | "path" | "language">[]> {
    try {
      return await this.query("GetFileImporters", { file_id });
    } catch {
      return [];
    }
  }

  async getImportEdges(file_id: string): Promise<ImportEdgeRecord[]> {
    try {
      return await this.query("GetImportEdges", { file_id });
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // 17. DESIGN SNAPSHOT CRUD
  // ==========================================================================

  async createDesignSnapshot(params: {
    repo_id: string;
    design_key: string;
    repo_name: string;
    penpot_file_id: string;
    penpot_project_id: string;
    file_name: string;
    agentfs_path: string;
    sha256: string;
    size_bytes: number;
    metadata_json: string;
    now_ms: number;
  }): Promise<DesignSnapshotCreateResult> {
    return this.query("CreateDesignSnapshot", params);
  }

  async getDesignSnapshot(design_id: string): Promise<Pick<DesignSnapshotRecord, "id" | "design_key" | "repo_name" | "penpot_file_id" | "penpot_project_id" | "created_at_ms" | "file_name" | "agentfs_path" | "sha256" | "size_bytes"> | null> {
    try {
      return await this.query("GetDesignSnapshot", { design_id });
    } catch {
      return null;
    }
  }

  async listRepoDesigns(repo_id: string): Promise<Pick<DesignSnapshotRecord, "id" | "design_key" | "file_name" | "created_at_ms" | "sha256">[]> {
    try {
      return await this.query("ListRepoDesigns", { repo_id });
    } catch {
      return [];
    }
  }

  async deleteDesignSnapshot(design_id: string): Promise<void> {
    await this.query("DeleteDesignSnapshot", { design_id });
  }

  // ==========================================================================
  // 18. PROPOSAL GRAPH QUERIES
  // ==========================================================================

  async createProposalDependency(params: {
    from_proposal_id: string;
    to_proposal_id: string;
    kind: string;
    now_ms: number;
  }): Promise<{ kind: string }> {
    return this.query("CreateProposalDependency", params);
  }

  async getProposalDependencies(proposal_id: string): Promise<Pick<ProposalRecord, "id" | "proposal_key" | "status" | "title">[]> {
    try {
      return await this.query("GetProposalDependencies", { proposal_id });
    } catch {
      return [];
    }
  }

  async getProposalDependents(proposal_id: string): Promise<Pick<ProposalRecord, "id" | "proposal_key" | "status" | "title">[]> {
    try {
      return await this.query("GetProposalDependents", { proposal_id });
    } catch {
      return [];
    }
  }

  async getConflictingProposals(proposal_id: string): Promise<Pick<ProposalRecord, "id" | "proposal_key" | "status">[]> {
    try {
      return await this.query("GetConflictingProposals", { proposal_id });
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // 19. KEY-BASED QUERIES (bypass ID requirement)
  // ==========================================================================
  // These methods use unique keys (repo_name, snapshot_key, proposal_key) instead
  // of IDs. This is necessary because the Helix codegen has a bug where including
  // `id: _::ID` in RETURN statements causes duplicate field errors in Rust.

  /**
   * List all snapshots for a repo by repo name.
   * Uses direct WHERE query instead of edge traversal.
   */
  async listSnapshotsByRepoName(repo_name: string): Promise<{
    snapshot_key: string;
    repo_name: string;
    status: string;
    created_at_ms: number;
    file_count: number;
    total_bytes: number;
    commit_sha: string;
    parent_snapshot_id: string;
  }[]> {
    try {
      return await this.query("ListSnapshotsByRepoName", { repo_name });
    } catch {
      return [];
    }
  }

  /**
   * List all proposals for a repo by repo name.
   * Uses direct WHERE query instead of edge traversal.
   */
  async listProposalsByRepoName(repo_name: string): Promise<{
    proposal_key: string;
    repo_name: string;
    status: string;
    title: string;
    created_by: string;
    created_at_ms: number;
    edit_count: number;
    base_snapshot_id: string;
  }[]> {
    try {
      return await this.query("ListProposalsByRepoName", { repo_name });
    } catch {
      return [];
    }
  }

  /**
   * Create a snapshot by repo name (no ID needed).
   * @param params.status - "pending" | "complete" | "failed" (defaults to "complete" since we add all files atomically)
   */
  async createSnapshotByRepoName(params: {
    repo_name: string;
    snapshot_key: string;
    parent_snapshot_id: string;
    commit_sha: string;
    now_ms: number;
    metadata_json: string;
    status?: string;
  }): Promise<{ snapshot_key: string; status: string }> {
    return this.query("CreateSnapshotByRepoName", {
      ...params,
      status: params.status ?? "complete",
    });
  }

  /**
   * Create a proposal by repo name (no ID needed).
   */
  async createProposalByRepoName(params: {
    repo_name: string;
    proposal_key: string;
    base_snapshot_id: string;
    created_by: string;
    title: string;
    description: string;
    now_ms: number;
    metadata_json: string;
  }): Promise<{ proposal_key: string; status: string }> {
    return this.query("CreateProposalByRepoName", params);
  }

  /**
   * Add a file to a snapshot by snapshot key.
   */
  async addFileToSnapshotByKey(params: {
    snapshot_key: string;
    file_key: string;
    path: string;
    content: string;
    sha256: string;
    language: string;
    size_bytes: number;
    line_count: number;
    now_ms: number;
  }): Promise<{ file_key: string; path: string; sha256: string }> {
    return this.query("AddFileToSnapshotByKey", params);
  }

  /**
   * Add an edit to a proposal by proposal key.
   */
  async addEditToProposalByKey(params: {
    proposal_key: string;
    edit_key: string;
    path: string;
    kind: string;
    content: string;
    sha256: string;
    old_path: string;
    now_ms: number;
    seq: number;
  }): Promise<{ edit_key: string; path: string; kind: string }> {
    return this.query("AddEditToProposalByKey", params);
  }

  /** @deprecated Use updateSnapshotStatusOnlyByKey - HelixDB UPDATE fails with U32/U64 params */
  async updateSnapshotStatusByKey(params: {
    snapshot_key: string;
    status: string;
    file_count: number;
    total_bytes: number;
  }): Promise<{ status: string; file_count: number }> {
    return this.query("UpdateSnapshotStatusByKey", params);
  }

  async updateSnapshotStatusOnlyByKey(params: {
    snapshot_key: string;
    status: string;
  }): Promise<{ status: string }> {
    return this.query("UpdateSnapshotStatusOnlyByKey", params);
  }

  /**
   * Update proposal status by key.
   */
  async updateProposalStatusByKey(params: {
    proposal_key: string;
    status: string;
    now_ms: number;
  }): Promise<{ status: string }> {
    return this.query("UpdateProposalStatusByKey", params);
  }

  /**
   * Update proposal edit count by key.
   */
  async updateProposalEditCountByKey(params: {
    proposal_key: string;
    edit_count: number;
    now_ms: number;
  }): Promise<{ edit_count: number }> {
    return this.query("UpdateProposalEditCountByKey", params);
  }

  /**
   * Update repo head by name.
   */
  async updateRepoHeadByName(params: {
    repo_name: string;
    head_snapshot_id: string;
    now_ms: number;
  }): Promise<{ head_snapshot_id: string }> {
    return this.query("UpdateRepoHeadByName", params);
  }

  async getSnapshotFilesByKey(snapshot_key: string): Promise<{
    id: string;
    file_key: string;
    path: string;
    sha256: string;
    language: string;
    size_bytes: number;
    line_count: number;
  }[]> {
    try {
      const result = await this.query("GetSnapshotFilesByKey", { snapshot_key });
      if (!result || typeof result !== "object") return [];
      if (Array.isArray(result)) return result;
      if (Object.keys(result).length === 0) return [];
      return [result] as {
        id: string;
        file_key: string;
        path: string;
        sha256: string;
        language: string;
        size_bytes: number;
        line_count: number;
      }[];
    } catch {
      return [];
    }
  }

  async getSnapshotFilesWithContentByKey(snapshot_key: string): Promise<{
    file_key: string;
    path: string;
    content: string;
    sha256: string;
    language: string;
    size_bytes: number;
    line_count: number;
  }[]> {
    try {
      const result = await this.query("GetSnapshotFilesWithContentByKey", { snapshot_key });
      if (!result || typeof result !== "object") return [];
      if (Array.isArray(result)) return result;
      if (Object.keys(result).length === 0) return [];
      return [result] as {
        file_key: string;
        path: string;
        content: string;
        sha256: string;
        language: string;
        size_bytes: number;
        line_count: number;
      }[];
    } catch {
      return [];
    }
  }

  /**
   * Get proposal edits by proposal key.
   */
  async getProposalEditsByKey(proposal_key: string): Promise<{
    edit_key: string;
    path: string;
    kind: string;
    sha256: string;
    old_path: string;
  }[]> {
    try {
      const result = await this.query("GetProposalEditsByKey", { proposal_key });
      if (!result || typeof result !== "object") return [];
      if (Array.isArray(result)) return result;
      if (Object.keys(result).length === 0) return [];
      return [result] as {
        edit_key: string;
        path: string;
        kind: string;
        sha256: string;
        old_path: string;
      }[];
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

/** Default client instance */
let defaultClient: HelixClient | null = null;

/**
 * Get or create the default HelixClient instance.
 * Uses HELIX_ENDPOINT environment variable if no options provided.
 * @param options - Optional client configuration
 * @returns HelixClient instance
 */
export function getDefaultHelixClient(options?: HelixClientOptions): HelixClient {
  if (!defaultClient) {
    defaultClient = new HelixClient(
      options ?? {
        endpoint: process.env.HELIX_ENDPOINT ?? "http://localhost:6969",
      }
    );
  }
  return defaultClient;
}

/**
 * Reset the default client instance.
 * Useful for testing or reconfiguration.
 */
export function resetDefaultHelixClient(): void {
  defaultClient = null;
}

/**
 * Create a new HelixClient with the given options.
 * Does not affect the default singleton.
 * @param options - Client configuration
 * @returns New HelixClient instance
 */
export function createHelixClient(options: HelixClientOptions): HelixClient {
  return new HelixClient(options);
}
