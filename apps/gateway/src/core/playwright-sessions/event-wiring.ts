import type { BrowserContext, Page } from "playwright";

import type { SessionId, ContextId, PageId, ContextRegistry } from "./context-registry.js";

/**
 * Callback for when a new page is created.
 */
type OnPageCreated = (params: {
  sessionId: SessionId;
  pageId: PageId;
  page: Page;
  openerPageId?: PageId;
  isPopup: boolean;
}) => void | Promise<void>;

/**
 * Callback for when a page is closed.
 */
type OnPageClosed = (params: {
  sessionId: SessionId;
  pageId: PageId;
}) => void | Promise<void>;

/**
 * Callback for when a context is closed.
 */
type OnContextClosed = (params: {
  sessionId: SessionId;
  contextId: ContextId;
}) => void | Promise<void>;

/**
 * Options for wiring context events.
 */
interface WireContextOptions {
  sessionId: SessionId;
  contextId: ContextId;
  context: BrowserContext;
  registry: ContextRegistry;

  generatePageId: () => PageId;

  onPageCreated?: OnPageCreated;
  onPageClosed?: OnPageClosed;
  onContextClosed?: OnContextClosed;
}

/**
 * Wire up event listeners for a BrowserContext to automatically
 * track new pages and attribute them to the session.
 *
 * @returns Cleanup function to remove listeners
 */
export function wireContextEvents(options: WireContextOptions): () => void {
  const {
    sessionId,
    contextId,
    context,
    registry,
    generatePageId,
    onPageCreated,
    onPageClosed,
    onContextClosed,
  } = options;

  const pageListeners = new Map<Page, () => void>();

  const handleNewPage = async (page: Page) => {
    const pageId = generatePageId();

    let openerPageId: PageId | undefined;
    let isPopup = false;

    try {
      const opener = await page.opener();
      if (opener) {
        openerPageId = registry.getPageId(sessionId, opener);
        isPopup = true;
      }
    } catch {
      // opener() can fail if page is already closed
    }

    const handle = registry.attachPage({
      sessionId,
      pageId,
      page,
      openerPageId,
      isPopup,
    });

    if (!handle) {
      console.error(`[event-wiring] Failed to attach page ${pageId} to session ${sessionId}`);
      return;
    }

    if (onPageCreated) {
      try {
        await onPageCreated({ sessionId, pageId, page, openerPageId, isPopup });
      } catch (err) {
        console.error(`[event-wiring] onPageCreated callback error:`, err);
      }
    }

    const handleClose = () => {
      registry.detachPage(sessionId, pageId);
      pageListeners.delete(page);

      if (onPageClosed) {
        Promise.resolve(onPageClosed({ sessionId, pageId })).catch((err) => {
          console.error(`[event-wiring] onPageClosed callback error:`, err);
        });
      }
    };

    page.once("close", handleClose);
    pageListeners.set(page, () => page.removeListener("close", handleClose));
  };

  const handleContextClose = () => {
    for (const cleanup of Array.from(pageListeners.values())) {
      try {
        cleanup();
      } catch {
        // ignore cleanup errors
      }
    }
    pageListeners.clear();

    if (onContextClosed) {
      Promise.resolve(onContextClosed({ sessionId, contextId })).catch((err) => {
        console.error(`[event-wiring] onContextClosed callback error:`, err);
      });
    }
  };

  context.on("page", handleNewPage);
  context.once("close", handleContextClose);

  return () => {
    context.removeListener("page", handleNewPage);
    context.removeListener("close", handleContextClose);
    for (const cleanup of Array.from(pageListeners.values())) {
      try {
        cleanup();
      } catch {
        // ignore cleanup errors
      }
    }
    pageListeners.clear();
  };
}

/**
 * Create a page ID generator for a session.
 */
export function createPageIdGenerator(sessionId: SessionId): () => PageId {
  let counter = 0;
  return () => `${sessionId}:page:${counter++}:${Date.now()}`;
}

/**
 * Wire an initial page that was created with the context.
 */
export async function wireInitialPage(params: {
  sessionId: SessionId;
  page: Page;
  pageId: PageId;
  registry: ContextRegistry;
  onPageCreated?: OnPageCreated;
  onPageClosed?: OnPageClosed;
}): Promise<void> {
  const { sessionId, page, pageId, registry, onPageCreated, onPageClosed } = params;

  const handle = registry.attachPage({
    sessionId,
    pageId,
    page,
    isPopup: false,
  });

  if (!handle) {
    throw new Error(`Failed to attach initial page ${pageId} to session ${sessionId}`);
  }

  if (onPageCreated) {
    await onPageCreated({ sessionId, pageId, page, isPopup: false });
  }

  page.once("close", () => {
    registry.detachPage(sessionId, pageId);
    if (onPageClosed) {
      Promise.resolve(onPageClosed({ sessionId, pageId })).catch((err) => {
        console.error(`[event-wiring] onPageClosed callback error:`, err);
      });
    }
  });
}
