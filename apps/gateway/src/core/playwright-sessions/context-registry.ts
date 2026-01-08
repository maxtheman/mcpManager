import type { BrowserContext, Page } from "playwright";

/**
 * Unique identifier for a session.
 */
export type SessionId = string;

/**
 * Unique identifier for a browser context.
 */
export type ContextId = string;

/**
 * Unique identifier for a page within a session.
 */
export type PageId = string;

/**
 * Lifecycle status of a session.
 * - "starting": Session is being initialized
 * - "active": Session is fully operational
 * - "ending": Session is being cleaned up
 * - "ended": Session has been properly closed
 * - "failed": Session encountered an error
 */
type SessionStatus = "starting" | "active" | "ending" | "ended" | "failed";

/**
 * In-memory representation of a page within a session.
 *
 * Tracks the Playwright Page object along with metadata for
 * tab management and lifecycle tracking.
 */
export interface PageHandle {
  /** Unique identifier for this page. */
  pageId: PageId;
  /** The Playwright Page instance. */
  page: Page;
  /** ID of the page that opened this one (for popups). */
  openerPageId?: PageId;
  /** Timestamp when the page was created. */
  createdAtMs: number;
  /** Timestamp when the page was closed (undefined if still open). */
  closedAtMs?: number;
  /** Whether this page was opened as a popup. */
  isPopup: boolean;
  /** Index for tab ordering within the session. */
  tabIndex: number;
}

/**
 * In-memory representation of a browser context.
 *
 * A context provides isolated browser state (cookies, storage, etc.)
 * and is the parent container for pages.
 */
interface ContextHandle {
  /** Unique identifier for this context. */
  contextId: ContextId;
  /** The Playwright BrowserContext instance. */
  context: BrowserContext;
  /** ID of the session that owns this context. */
  sessionId: SessionId;
  /** Timestamp when the context was created. */
  createdAtMs: number;
  /** Timestamp when the context was closed (undefined if still open). */
  closedAtMs?: number;
}

/**
 * In-memory session state containing Playwright objects.
 *
 * This mirrors the session data in Helix DB but holds the actual
 * Playwright objects (Context, Page) that cannot be serialized.
 * The registry provides fast lookup and lifecycle management for
 * these runtime objects.
 */
interface SessionHandle {
  /** Unique identifier for this session. */
  sessionId: SessionId;
  /** Optional user-provided key for session lookup. */
  sessionKey?: string;
  /** Identifier of the agent that owns this session. */
  ownerAgent: string;
  /** Current lifecycle status of the session. */
  status: SessionStatus;

  /** The browser context handle for this session. */
  contextHandle: ContextHandle;
  /** ID of the currently active page (for tool operations). */
  activePageId?: PageId;

  /** Map of page ID to PageHandle for all pages in this session. */
  pageById: Map<PageId, PageHandle>;
  /** Reverse lookup from Page object to its ID. */
  pageIdByPage: WeakMap<Page, PageId>;

  /** Counter for assigning tab indices to new pages. */
  nextTabIndex: number;
  /** Counter for command sequence numbers. */
  nextSeq: number;

  /** Timestamp when the session was created. */
  createdAtMs: number;
  /** Timestamp of the last session update. */
  updatedAtMs: number;
  /** Timestamp when the session should expire if inactive. */
  expiresAtMs: number;
}

/**
 * Registry for tracking active sessions and their Playwright objects.
 *
 * This is the in-memory complement to Helix DB persistence. Playwright
 * objects (BrowserContext, Page) cannot be serialized to the database,
 * so we maintain them here with fast lookup capabilities.
 *
 * Key features:
 * - Session tracking with context and page management
 * - Bidirectional lookups (session ↔ context, page ↔ pageId)
 * - Active page tracking for tool operations
 * - Lifecycle management with status tracking
 * - Expiration tracking for cleanup
 *
 * @example
 * ```typescript
 * const registry = getDefaultContextRegistry();
 *
 * // Register a new session
 * const session = registry.addSession({
 *   sessionId: "sess_123",
 *   ownerAgent: "agent_456",
 *   contextId: "ctx_789",
 *   context: browserContext,
 *   expiresAtMs: Date.now() + 900_000,
 * });
 *
 * // Attach a page
 * registry.attachPage({
 *   sessionId: "sess_123",
 *   pageId: "page_001",
 *   page: playwrightPage,
 *   isPopup: false,
 * });
 *
 * // Get active page for operations
 * const activePage = registry.getActivePage("sess_123");
 * ```
 */
export class ContextRegistry {
  private sessions = new Map<SessionId, SessionHandle>();
  private contextToSession = new Map<ContextId, SessionId>();

  /**
   * Register a new session with its browser context.
   *
   * Creates the session handle with initial state and registers
   * the context for reverse lookup.
   *
   * @param params - Session registration parameters.
   * @param params.sessionId - Unique identifier for the session.
   * @param params.sessionKey - Optional user-provided key for lookup.
   * @param params.ownerAgent - ID of the owning agent.
   * @param params.contextId - Unique identifier for the context.
   * @param params.context - The Playwright BrowserContext instance.
   * @param params.expiresAtMs - Expiration timestamp for the session.
   * @returns The created SessionHandle.
   */
  addSession(params: {
    sessionId: SessionId;
    sessionKey?: string;
    ownerAgent: string;
    contextId: ContextId;
    context: BrowserContext;
    expiresAtMs: number;
  }): SessionHandle {
    const now = Date.now();
    const contextHandle: ContextHandle = {
      contextId: params.contextId,
      context: params.context,
      sessionId: params.sessionId,
      createdAtMs: now,
    };

    const session: SessionHandle = {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ownerAgent: params.ownerAgent,
      status: "starting",
      contextHandle,
      pageById: new Map(),
      pageIdByPage: new WeakMap(),
      nextTabIndex: 0,
      nextSeq: 0,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: params.expiresAtMs,
    };

    this.sessions.set(params.sessionId, session);
    this.contextToSession.set(params.contextId, params.sessionId);

    return session;
  }

  /**
   * Get a session by its ID.
   *
   * @param sessionId - The session ID to look up.
   * @returns The SessionHandle or null if not found.
   */
  getSession(sessionId: SessionId): SessionHandle | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get a session by its context ID.
   *
   * Useful for finding the session when you only have the context.
   *
   * @param contextId - The context ID to look up.
   * @returns The SessionHandle or null if not found.
   */
  getSessionByContext(contextId: ContextId): SessionHandle | null {
    const sessionId = this.contextToSession.get(contextId);
    return sessionId ? this.getSession(sessionId) : null;
  }

  /**
   * Update the lifecycle status of a session.
   *
   * Also updates the session's updatedAtMs timestamp.
   *
   * @param sessionId - The session to update.
   * @param status - The new status.
   */
  setSessionStatus(sessionId: SessionId, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.updatedAtMs = Date.now();
    }
  }

  /**
   * Register a new page in a session.
   *
   * Creates a PageHandle and sets up bidirectional lookups.
   * If this is the first page, it becomes the active page.
   *
   * @param params - Page registration parameters.
   * @param params.sessionId - ID of the session to attach to.
   * @param params.pageId - Unique identifier for the page.
   * @param params.page - The Playwright Page instance.
   * @param params.openerPageId - ID of the page that opened this one (for popups).
   * @param params.isPopup - Whether this page was opened as a popup.
   * @returns The created PageHandle or null if session not found.
   */
  attachPage(params: {
    sessionId: SessionId;
    pageId: PageId;
    page: Page;
    openerPageId?: PageId;
    isPopup: boolean;
  }): PageHandle | null {
    const session = this.sessions.get(params.sessionId);
    if (!session) return null;

    const handle: PageHandle = {
      pageId: params.pageId,
      page: params.page,
      openerPageId: params.openerPageId,
      createdAtMs: Date.now(),
      isPopup: params.isPopup,
      tabIndex: session.nextTabIndex++,
    };

    session.pageById.set(params.pageId, handle);
    session.pageIdByPage.set(params.page, params.pageId);
    session.updatedAtMs = Date.now();

    // Set as active if it's the first page
    if (!session.activePageId) {
      session.activePageId = params.pageId;
    }

    return handle;
  }

  /**
   * Detach a page (mark as closed).
   *
   * The page is not removed from the registry but marked with a
   * closedAtMs timestamp. This preserves history while indicating
   * the page is no longer usable. If this was the active page,
   * another open page is selected as active.
   *
   * @param sessionId - The session containing the page.
   * @param pageId - The page to detach.
   */
  detachPage(sessionId: SessionId, pageId: PageId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const handle = session.pageById.get(pageId);
    if (handle) {
      handle.closedAtMs = Date.now();
      // Note: Don't delete from pageById - keep for history

      // If this was the active page, try to find another
      if (session.activePageId === pageId) {
        session.activePageId = undefined;
        for (const [id, h] of Array.from(session.pageById.entries())) {
          if (!h.closedAtMs) {
            session.activePageId = id;
            break;
          }
        }
      }
    }
  }

  /**
   * Get the page ID for a Playwright Page object.
   *
   * @param sessionId - The session containing the page.
   * @param page - The Playwright Page instance.
   * @returns The PageId or undefined if not found.
   */
  getPageId(sessionId: SessionId, page: Page): PageId | undefined {
    const session = this.sessions.get(sessionId);
    return session?.pageIdByPage.get(page);
  }

  /**
   * Get a page by its ID.
   *
   * @param sessionId - The session containing the page.
   * @param pageId - The page ID to look up.
   * @returns The PageHandle or null if not found.
   */
  getPage(sessionId: SessionId, pageId: PageId): PageHandle | null {
    const session = this.sessions.get(sessionId);
    return session?.pageById.get(pageId) ?? null;
  }

  /**
   * Get the currently active page for a session.
   *
   * The active page is the one that receives tool operations.
   *
   * @param sessionId - The session to query.
   * @returns The active PageHandle or null if none.
   */
  getActivePage(sessionId: SessionId): PageHandle | null {
    const session = this.sessions.get(sessionId);
    if (!session?.activePageId) return null;
    return session.pageById.get(session.activePageId) ?? null;
  }

  /**
   * Set the active page for a session.
   *
   * The page must exist and not be closed.
   *
   * @param sessionId - The session to update.
   * @param pageId - The page to make active.
   * @returns true if successful, false if session/page not found or page is closed.
   */
  setActivePage(sessionId: SessionId, pageId: PageId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const handle = session.pageById.get(pageId);
    if (!handle || handle.closedAtMs) return false;

    session.activePageId = pageId;
    session.updatedAtMs = Date.now();
    return true;
  }

  /**
   * Get all open (non-closed) pages for a session.
   *
   * @param sessionId - The session to query.
   * @returns Array of open PageHandles.
   */
  getOpenPages(sessionId: SessionId): PageHandle[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return Array.from(session.pageById.values()).filter((h) => !h.closedAtMs);
  }

  /**
   * Get the next sequence number for command tracking.
   *
   * Sequence numbers are used to order operations within a session.
   *
   * @param sessionId - The session to get sequence for.
   * @returns The next sequence number, or 0 if session not found.
   */
  nextSequence(sessionId: SessionId): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    return session.nextSeq++;
  }

  /**
   * Remove a session entirely from the registry.
   *
   * Call this after the session's browser context has been closed
   * and all cleanup is complete.
   *
   * @param sessionId - The session to remove.
   */
  removeSession(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.contextToSession.delete(session.contextHandle.contextId);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * List all sessions in the registry.
   *
   * @returns Array of all SessionHandles.
   */
  listSessions(): SessionHandle[] {
    return Array.from(this.sessions.values());
  }

  /**
   * List sessions owned by a specific agent.
   *
   * @param ownerAgent - The agent ID to filter by.
   * @returns Array of SessionHandles owned by the agent.
   */
  listSessionsByOwner(ownerAgent: string): SessionHandle[] {
    return Array.from(this.sessions.values()).filter((s) => s.ownerAgent === ownerAgent);
  }

  /**
   * List sessions that have exceeded their expiration time.
   *
   * Only returns sessions that are not already ended or failed.
   *
   * @returns Array of expired SessionHandles.
   */
  listExpiredSessions(): SessionHandle[] {
    const now = Date.now();
    return Array.from(this.sessions.values()).filter(
      (s) => s.expiresAtMs <= now && s.status !== "ended" && s.status !== "failed"
    );
  }

  /**
   * Get statistics about the registry contents.
   *
   * @returns Object with session, context, and page counts.
   */
  getStats(): { sessions: number; contexts: number; totalPages: number; openPages: number } {
    let totalPages = 0;
    let openPages = 0;

    for (const session of Array.from(this.sessions.values())) {
      totalPages += session.pageById.size;
      for (const page of Array.from(session.pageById.values())) {
        if (!page.closedAtMs) openPages++;
      }
    }

    return {
      sessions: this.sessions.size,
      contexts: this.contextToSession.size,
      totalPages,
      openPages,
    };
  }
}

// Singleton instance for the gateway process
let defaultRegistry: ContextRegistry | null = null;

/**
 * Get the default singleton ContextRegistry instance.
 *
 * Creates a new instance on first call. Subsequent calls return
 * the existing instance.
 *
 * @returns The singleton ContextRegistry instance.
 */
export function getDefaultContextRegistry(): ContextRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ContextRegistry();
  }
  return defaultRegistry;
}
