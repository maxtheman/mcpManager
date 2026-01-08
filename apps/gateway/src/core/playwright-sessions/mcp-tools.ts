import {
  getDefaultSessionManager,
  type SessionManager,
  type SessionStartParams,
} from "./session-manager.js";
import type { PlaywrightToolName } from "./tool-dispatch.js";

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
};

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asToolResponse(value: unknown): ToolResponse {
  return { content: [{ type: "text", text: asJsonText(value) }] };
}

const PLAYWRIGHT_SESSION_TOOL_NAMES = {
  sessionStart: "playwright_session_start",
  sessionCall: "playwright_session_call",
  sessionEnd: "playwright_session_end",
  sessionList: "playwright_session_list",
  sessionTabs: "playwright_session_tabs",
  sessionInspect: "playwright_session_inspect",
  sessionNewTab: "playwright_session_new_tab",
  sessionCloseTab: "playwright_session_close_tab",
  sessionSetActivePage: "playwright_session_set_active_page",
} as const;

export const PLAYWRIGHT_SESSION_TOOL_DEFS = [
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionStart,
    description:
      "Start a new in-process Playwright session with an isolated BrowserContext. Session IDs are only valid for the lifetime of this gateway process; restarting the gateway invalidates them.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description: "Optional key to resume an existing session",
        },
        ttlSeconds: {
          type: "integer",
          minimum: 30,
          maximum: 3600,
          default: 900,
          description: "Session TTL in seconds (default: 900 = 15 minutes)",
        },
        initialUrl: {
          type: "string",
          description: "Initial URL to navigate to",
        },
        ownerId: {
          type: "string",
          description: "Owner identifier (e.g., agent ID)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionCall,
    description:
      "Execute a Playwright tool within a session. Commands are queued and executed sequentially per session (use playwright_pool_* for cross-process coordination).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID from session_start" },
        tool: {
          type: "string",
          enum: [
            "browser_navigate",
            "browser_click",
            "browser_type",
            "browser_fill_form",
            "browser_press_key",
            "browser_hover",
            "browser_select_option",
            "browser_drag",
            "browser_snapshot",
            "browser_take_screenshot",
            "browser_evaluate",
            "browser_wait_for",
            "browser_navigate_back",
          ],
          description: "The Playwright tool to execute",
        },
        arguments: { type: "object", description: "Arguments for the tool" },
        pageId: { type: "string", description: "Target page ID (defaults to active page)" },
      },
      required: ["sessionId", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionEnd,
    description: "End a Playwright session and clean up all resources (context, pages).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to end" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionList,
    description: "List all active Playwright sessions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionTabs,
    description: "List all tabs (pages) in a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to query" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionInspect,
    description: "Get detailed information about a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to inspect" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionNewTab,
    description: "Create a new tab in a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID" },
        url: { type: "string", description: "Optional URL to navigate to" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionCloseTab,
    description: "Close a specific tab in a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID" },
        pageId: { type: "string", description: "The page ID to close" },
      },
      required: ["sessionId", "pageId"],
      additionalProperties: false,
    },
  },
  {
    name: PLAYWRIGHT_SESSION_TOOL_NAMES.sessionSetActivePage,
    description: "Set the active page for a session. Subsequent calls will target this page by default.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID" },
        pageId: { type: "string", description: "The page ID to make active" },
      },
      required: ["sessionId", "pageId"],
      additionalProperties: false,
    },
  },
];

export async function handlePlaywrightSessionTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResponse | null> {
  const manager = getDefaultSessionManager();

  const handlers: Record<
    string,
    (toolArgs: Record<string, unknown>, sessionManager: SessionManager) => Promise<unknown> | unknown
  > =
    {
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionStart]: async (toolArgs, sessionManager) => {
        const params: SessionStartParams = {
          sessionKey: typeof toolArgs.sessionKey === "string" ? toolArgs.sessionKey : undefined,
          ttlSeconds: typeof toolArgs.ttlSeconds === "number" ? toolArgs.ttlSeconds : undefined,
          initialUrl: typeof toolArgs.initialUrl === "string" ? toolArgs.initialUrl : undefined,
          ownerId: typeof toolArgs.ownerId === "string" ? toolArgs.ownerId : undefined,
        };
        return sessionManager.start(params);
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionCall]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        const tool = String(toolArgs.tool ?? "") as PlaywrightToolName;
        const argumentsObject =
          typeof toolArgs.arguments === "object" && toolArgs.arguments !== null
            ? (toolArgs.arguments as Record<string, unknown>)
            : {};
        const pageId = typeof toolArgs.pageId === "string" ? toolArgs.pageId : undefined;

        if (!sessionId) {
          return { ok: false, error: "sessionId required" };
        }
        if (!tool) {
          return { ok: false, error: "tool required" };
        }

        return sessionManager.call({ sessionId, tool, arguments: argumentsObject, pageId });
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionEnd]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        if (!sessionId) {
          return { ok: false, error: "sessionId required" };
        }
        return sessionManager.end({ sessionId });
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionList]: (_toolArgs, sessionManager) => {
        return sessionManager.list();
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionTabs]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        if (!sessionId) {
          return { ok: false, error: "sessionId required" };
        }
        return sessionManager.tabs(sessionId);
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionInspect]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        if (!sessionId) {
          return { ok: false, error: "sessionId required" };
        }
        return sessionManager.inspect(sessionId);
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionNewTab]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        const url = typeof toolArgs.url === "string" ? toolArgs.url : undefined;
        if (!sessionId) {
          return { ok: false, error: "sessionId required" };
        }
        return sessionManager.newTab(sessionId, url);
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionCloseTab]: async (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        const pageId = String(toolArgs.pageId ?? "");
        if (!sessionId || !pageId) {
          return { ok: false, error: "sessionId and pageId required" };
        }
        return sessionManager.closeTab(sessionId, pageId);
      },
      [PLAYWRIGHT_SESSION_TOOL_NAMES.sessionSetActivePage]: (toolArgs, sessionManager) => {
        const sessionId = String(toolArgs.sessionId ?? "");
        const pageId = String(toolArgs.pageId ?? "");
        if (!sessionId || !pageId) {
          return { ok: false, error: "sessionId and pageId required" };
        }
        const ok = sessionManager.setActivePage(sessionId, pageId);
        return { ok };
      },
    };

  const handler = handlers[name];
  if (!handler) return null;
  const result = await handler(args, manager);
  return asToolResponse(result);
}

export function isPlaywrightSessionTool(name: string): boolean {
  return Object.values(PLAYWRIGHT_SESSION_TOOL_NAMES).includes(name as any);
}
