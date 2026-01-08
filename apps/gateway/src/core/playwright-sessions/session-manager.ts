import { randomUUID } from "node:crypto";

import { getDefaultBrowserProvider, type BrowserProvider } from "./browser-provider.js";
import {
  getDefaultContextRegistry,
  type ContextId,
  type ContextRegistry,
  type PageHandle,
  type PageId,
  type SessionId,
} from "./context-registry.js";
import { createPageIdGenerator, wireContextEvents, wireInitialPage } from "./event-wiring.js";
import { getDefaultQueueRegistry } from "./session-queue.js";
import { dispatchTool, type DispatchResult, type PlaywrightToolName } from "./tool-dispatch.js";

interface SessionManagerOptions {
  defaultTtlMs?: number;
  browserOptions?: {
    headless?: boolean;
    executablePath?: string;
  };
}

export interface SessionStartParams {
  sessionKey?: string;
  ttlSeconds?: number;
  initialUrl?: string;
  ownerId?: string;
}

interface SessionStartResult {
  ok: true;
  sessionId: SessionId;
  pageId: PageId;
  reused: boolean;
}

interface SessionCallParams {
  sessionId: SessionId;
  tool: PlaywrightToolName;
  arguments: Record<string, unknown>;
  pageId?: PageId;
}

interface SessionCallResult {
  ok: boolean;
  result?: DispatchResult;
  error?: string;
}

interface SessionEndParams {
  sessionId: SessionId;
}

interface SessionEndResult {
  ok: boolean;
  error?: string;
}

interface SessionListResult {
  sessions: Array<{
    sessionId: SessionId;
    ownerId?: string;
    status: string;
    pageCount: number;
    activePageId?: PageId;
    createdAt: number;
  }>;
}

interface SessionTabsResult {
  sessionId: SessionId;
  pages: Array<{
    pageId: PageId;
    url: string;
    title: string;
    isActive: boolean;
  }>;
}

interface SessionInspectResult {
  sessionId: SessionId;
  ownerId?: string;
  status: string;
  pages: Array<{
    pageId: PageId;
    url: string;
    title: string;
  }>;
  createdAt: number;
  ttlSeconds: number;
}

export class SessionManager {
  private readonly registry: ContextRegistry;
  private readonly browserProvider: BrowserProvider;
  private readonly options: Required<SessionManagerOptions>;
  private readonly sessionKeys = new Map<string, SessionId>();
  private readonly sessionCleanup = new Map<SessionId, () => void>();

  constructor(options: SessionManagerOptions = {}) {
    this.options = {
      defaultTtlMs: options.defaultTtlMs ?? 15 * 60 * 1000,
      browserOptions: options.browserOptions ?? { headless: true },
    };
    this.registry = getDefaultContextRegistry();
    this.browserProvider = getDefaultBrowserProvider();
  }

  async start(params: SessionStartParams = {}): Promise<SessionStartResult | { ok: false; error: string }> {
    const { sessionKey, ttlSeconds, initialUrl, ownerId } = params;
    const ttlMs = (ttlSeconds ?? 900) * 1000;

    if (sessionKey) {
      const existingId = this.sessionKeys.get(sessionKey);
      if (existingId) {
        const handle = this.registry.getSession(existingId);
        if (handle) {
          const activePage = this.registry.getActivePage(existingId);
          return {
            ok: true,
            sessionId: existingId,
            pageId: activePage?.pageId ?? `${existingId}:page:0`,
            reused: true,
          };
        }
        this.sessionKeys.delete(sessionKey);
      }
    }

    const browserHandle = await this.browserProvider.acquire();
    const context = await browserHandle.browser.newContext();
    const sessionId: SessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const contextId: ContextId = `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    this.registry.addSession({
      sessionId,
      sessionKey,
      ownerAgent: ownerId ?? "unknown",
      contextId,
      context,
      expiresAtMs: Date.now() + ttlMs,
    });

    this.registry.setSessionStatus(sessionId, "active");

    const generatePageId = createPageIdGenerator(sessionId);
    const cleanupFn = wireContextEvents({
      sessionId,
      contextId,
      context,
      registry: this.registry,
      generatePageId,
      onPageCreated: async ({ pageId }) => {
        this.registry.setActivePage(sessionId, pageId);
      },
    });

    this.sessionCleanup.set(sessionId, cleanupFn);

    const pages = context.pages();
    const initialPage = pages[0] ?? (await context.newPage());
    const initialPageId = generatePageId();

    await wireInitialPage({
      sessionId,
      page: initialPage,
      pageId: initialPageId,
      registry: this.registry,
    });

    this.registry.setActivePage(sessionId, initialPageId);

    if (sessionKey) {
      this.sessionKeys.set(sessionKey, sessionId);
    }

    if (initialUrl) {
      await initialPage.goto(initialUrl, { waitUntil: "domcontentloaded" });
    }

    return {
      ok: true,
      sessionId,
      pageId: initialPageId,
      reused: false,
    };
  }

  async call(params: SessionCallParams): Promise<SessionCallResult> {
    const { sessionId, tool, arguments: args, pageId } = params;

    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, error: `Unknown session: ${sessionId}` };
    }

    let targetPage: PageHandle | null = null;
    if (pageId) {
      targetPage = this.registry.getPage(sessionId, pageId);
    } else {
      targetPage = this.registry.getActivePage(sessionId);
    }

    if (!targetPage) {
      return { ok: false, error: "No active page in session" };
    }

    const queue = getDefaultQueueRegistry().forSession(sessionId);
    const context = session.contextHandle.context;

    const result = await queue.enqueue(async () => {
      return dispatchTool({
        tool,
        page: targetPage!.page,
        context,
        args,
      });
    });

    return { ok: true, result };
  }

  async end(params: SessionEndParams): Promise<SessionEndResult> {
    const { sessionId } = params;

    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, error: `Unknown session: ${sessionId}` };
    }

    const cleanupFn = this.sessionCleanup.get(sessionId);
    if (cleanupFn) {
      try {
        cleanupFn();
      } catch {
        // ignore cleanup errors
      }
      this.sessionCleanup.delete(sessionId);
    }

    try {
      await session.contextHandle.context.close();
    } catch {
      // ignore close errors
    }

    this.registry.setSessionStatus(sessionId, "ended");
    this.registry.removeSession(sessionId);

    for (const [key, id] of Array.from(this.sessionKeys.entries())) {
      if (id === sessionId) {
        this.sessionKeys.delete(key);
        break;
      }
    }

    this.browserProvider.release();
    await getDefaultQueueRegistry().remove(sessionId);

    return { ok: true };
  }

  list(): SessionListResult {
    const sessions: SessionListResult["sessions"] = [];

    for (const session of this.registry.listSessions()) {
      const openPages = this.registry.getOpenPages(session.sessionId);
      const activePage = this.registry.getActivePage(session.sessionId);

      sessions.push({
        sessionId: session.sessionId,
        ownerId: session.ownerAgent,
        status: session.status,
        pageCount: openPages.length,
        activePageId: activePage?.pageId,
        createdAt: session.createdAtMs,
      });
    }

    return { sessions };
  }

  async tabs(sessionId: SessionId): Promise<SessionTabsResult | { ok: false; error: string }> {
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, error: `Unknown session: ${sessionId}` };
    }

    const activePage = this.registry.getActivePage(sessionId);
    const openPages = this.registry.getOpenPages(sessionId);

    const pages = await Promise.all(
      openPages.map(async (handle) => {
        let url = "";
        let title = "";
        try {
          url = handle.page.url();
          title = await handle.page.title();
        } catch {
          // ignore transient page errors
        }
        return {
          pageId: handle.pageId,
          url,
          title,
          isActive: handle.pageId === activePage?.pageId,
        };
      })
    );

    return { sessionId, pages };
  }

  async inspect(sessionId: SessionId): Promise<SessionInspectResult | { ok: false; error: string }> {
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, error: `Unknown session: ${sessionId}` };
    }

    const openPages = this.registry.getOpenPages(sessionId);

    const pages = await Promise.all(
      openPages.map(async (handle) => {
        let url = "";
        let title = "";
        try {
          url = handle.page.url();
          title = await handle.page.title();
        } catch {
          // ignore transient page errors
        }
        return {
          pageId: handle.pageId,
          url,
          title,
        };
      })
    );

    return {
      sessionId,
      ownerId: session.ownerAgent,
      status: session.status,
      pages,
      createdAt: session.createdAtMs,
      ttlSeconds: Math.floor((session.expiresAtMs - Date.now()) / 1000),
    };
  }

  setActivePage(sessionId: SessionId, pageId: PageId): boolean {
    return this.registry.setActivePage(sessionId, pageId);
  }

  async newTab(sessionId: SessionId, url?: string): Promise<{ ok: true; pageId: PageId } | { ok: false; error: string }> {
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, error: `Unknown session: ${sessionId}` };
    }

    const page = await session.contextHandle.context.newPage();
    const pageId = createPageIdGenerator(sessionId)();

    const handle = this.registry.attachPage({
      sessionId,
      pageId,
      page,
      isPopup: false,
    });

    if (!handle) {
      await page.close();
      return { ok: false, error: "Failed to attach page" };
    }

    this.registry.setActivePage(sessionId, pageId);

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    return { ok: true, pageId };
  }

  async closeTab(sessionId: SessionId, pageId: PageId): Promise<{ ok: boolean; error?: string }> {
    const pageHandle = this.registry.getPage(sessionId, pageId);
    if (!pageHandle) {
      return { ok: false, error: `Unknown page: ${pageId}` };
    }

    try {
      await pageHandle.page.close();
    } catch {
      // ignore close errors
    }

    this.registry.detachPage(sessionId, pageId);

    const activePage = this.registry.getActivePage(sessionId);
    if (activePage?.pageId === pageId) {
      const remaining = this.registry.getOpenPages(sessionId);
      if (remaining.length > 0) {
        this.registry.setActivePage(sessionId, remaining[0].pageId);
      }
    }

    return { ok: true };
  }

  async shutdown(): Promise<void> {
    const sessions = this.registry.listSessions();
    for (const session of sessions) {
      await this.end({ sessionId: session.sessionId });
    }
    await this.browserProvider.shutdown();
  }
}

const DEFAULT_SESSION_MANAGER_KEY = Symbol.for("Mx.playwrightSessions.defaultSessionManager");

function isSessionManagerLike(value: unknown): value is SessionManager {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return (
    typeof v.start === "function" &&
    typeof v.call === "function" &&
    typeof v.end === "function" &&
    typeof v.list === "function" &&
    typeof v.shutdown === "function"
  );
}

export function getDefaultSessionManager(): SessionManager {
  const existing = (globalThis as any)[DEFAULT_SESSION_MANAGER_KEY] as unknown;
  if (isSessionManagerLike(existing)) return existing;
  const manager = new SessionManager();
  (globalThis as any)[DEFAULT_SESSION_MANAGER_KEY] = manager;
  return manager;
}
