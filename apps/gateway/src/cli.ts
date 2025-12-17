import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createDaytonaClient, type DaytonaHandle } from "./daytona/daytona.js";
import {
  createEphemeralKey,
  listDevices,
  type TailscaleHandle,
} from "./tailscale/tailscale.js";
import { readRegistry, type Upstream } from "./registry/registry.js";
import { audit, checkPolicy } from "./policy/policy.js";
import {
  configuredPoolIds,
  listPoolStatus,
  poolEnabled,
  releaseLock,
  tryAcquireLock,
} from "./playwright/pool.js";
import { randomUUID } from "node:crypto";

type ToolResponse = {
  content: any[];
};

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const server = new Server(
  { name: "mcpmanager-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const healthPingInput = z.object({}).strict();

const tailscaleListDevicesInput = z
  .object({
    tailnet: z.string().min(1).optional().describe("Tailnet name or '-'"),
  })
  .strict();

const tailscaleCreateKeyInput = z
  .object({
    tailnet: z.string().min(1).optional().describe("Tailnet name or '-'"),
    tags: z.array(z.string().min(1)).default([]),
    expirySeconds: z.number().int().positive().default(3600),
    reusable: z.boolean().default(false),
    ephemeral: z.boolean().default(true),
    preauthorized: z.boolean().default(true),
    description: z.string().optional(),
  })
  .strict();

const daytonaCreateSandboxInput = z
  .object({
    target: z.string().optional(),
    autoStopIntervalMinutes: z.number().int().nonnegative().optional(),
    language: z.string().optional(),
  })
  .strict();

const daytonaDeleteSandboxInput = z
  .object({
    sandboxId: z.string().min(1),
  })
  .strict();

const daytonaExecuteCommandInput = z
  .object({
    sandboxId: z.string().min(1),
    command: z.string().min(1),
  })
  .strict();

let daytona: DaytonaHandle | null = null;
let tailscale: TailscaleHandle | null = null;
let upstreams: Upstream[] = [];
const upstreamClients = new Map<string, Client>();
const upstreamErrors = new Map<string, string>();
const heldPlaywrightLeases = new Set<string>();
const playwrightSessions = new Map<string, { upstreamId: string; tabIndex: number }>();
let toolRoutes:
  | {
      byToolName: Map<string, { upstreamId: string; upstreamTool: string }>;
      builtInNames: Set<string>;
      toolDefs: any[];
    }
  | null = null;

function getDaytona(): DaytonaHandle {
  if (!daytona) daytona = createDaytonaClient();
  return daytona;
}

function getTailscale(): TailscaleHandle {
  if (!tailscale) tailscale = { apiKey: process.env.TAILSCALE_API_KEY ?? "" };
  return tailscale;
}

async function loadRegistry() {
  const reg = await readRegistry();
  upstreams = reg.upstreams.filter((u) => u.enabled);
  toolRoutes = null;
  upstreamErrors.clear();
  for (const [id, client] of upstreamClients.entries()) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    upstreamClients.delete(id);
  }
}

function buildUpstreamEnv(upstream: Upstream): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of upstream.env_vars ?? []) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(upstream.env ?? {})) {
    env[k] = v;
  }
  // Always preserve PATH so stdio servers can spawn their dependencies.
  if (process.env.PATH && !env.PATH) env.PATH = process.env.PATH;
  return env;
}

async function getUpstreamClient(upstreamId: string): Promise<{ upstream: Upstream; client: Client }> {
  const upstream = upstreams.find((u) => u.id === upstreamId);
  if (!upstream) throw new Error(`Unknown upstream: ${upstreamId}`);

  const existing = upstreamClients.get(upstreamId);
  if (existing) return { upstream, client: existing };

  const transport = new StdioClientTransport({
    command: upstream.command,
    args: upstream.args ?? [],
    env: buildUpstreamEnv(upstream),
  });
  const client = new Client(
    { name: `mcpmanager-upstream-${upstreamId}`, version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    upstreamClients.set(upstreamId, client);
    upstreamErrors.delete(upstreamId);
    return { upstream, client };
  } catch (e) {
    upstreamErrors.set(upstreamId, String(e));
    try {
      await client.close();
    } catch {
      // ignore
    }
    throw e;
  }
}

async function ensureToolRoutes() {
  if (toolRoutes) return toolRoutes;

  const builtInNames = new Set<string>([
    "health.ping",
    "tailscale.devices.list",
    "tailscale.keys.createEphemeral",
    "daytona.sandbox.create",
    "daytona.sandbox.delete",
    "daytona.process.exec",
    "mcpmanager.upstreams.list",
    "mcpmanager.upstreams.reload",
  ]);

  const toolNameCounts = new Map<string, number>();
  const upstreamToolDefs: Array<{ upstreamId: string; tool: any }> = [];

  for (const upstream of upstreams) {
    try {
      const { client } = await getUpstreamClient(upstream.id);
      const list = await client.listTools();
      for (const t of list.tools ?? []) {
        upstreamToolDefs.push({ upstreamId: upstream.id, tool: t });
        toolNameCounts.set(t.name, (toolNameCounts.get(t.name) ?? 0) + 1);
      }
    } catch (e) {
      upstreamErrors.set(upstream.id, String(e));
    }
  }

  const byToolName = new Map<string, { upstreamId: string; upstreamTool: string }>();
  for (const { upstreamId, tool } of upstreamToolDefs) {
    // Always expose a prefixed name.
    byToolName.set(`${upstreamId}.${tool.name}`, { upstreamId, upstreamTool: tool.name });
  }

  // Also expose unprefixed aliases when unique and not colliding with built-ins.
  for (const { upstreamId, tool } of upstreamToolDefs) {
    if (builtInNames.has(tool.name)) continue;
    if ((toolNameCounts.get(tool.name) ?? 0) !== 1) continue;
    if (!byToolName.has(tool.name)) {
      byToolName.set(tool.name, { upstreamId, upstreamTool: tool.name });
    }
  }

  const toolDefs: any[] = [];
  for (const { upstreamId, tool } of upstreamToolDefs) {
    toolDefs.push({ ...tool, name: `${upstreamId}.${tool.name}` });
  }
  for (const { upstreamId, tool } of upstreamToolDefs) {
    if (builtInNames.has(tool.name)) continue;
    if ((toolNameCounts.get(tool.name) ?? 0) !== 1) continue;
    toolDefs.push({ ...tool, name: tool.name });
  }

  toolRoutes = { byToolName, builtInNames, toolDefs };
  return toolRoutes;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const routes = await ensureToolRoutes();
  return {
    tools: [
      {
        name: "health.ping",
        description: "Health check for mcpManager gateway.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "mcpmanager.upstreams.list",
        description: "List enabled upstream MCP servers configured in ~/.mcpmanager/registry.json.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "mcpmanager.upstreams.reload",
        description: "Reload ~/.mcpmanager/registry.json and reconnect upstreams.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      ...(poolEnabled()
        ? [
            {
              name: "playwright_pool.list",
              description:
                "List configured Playwright pool slots and whether they are locked (set MCPMANAGER_PLAYWRIGHT_POOL to enable).",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: "playwright_pool.reserve",
              description:
                "Reserve a Playwright pool slot for this gateway process (exclusive lock across agents).",
              inputSchema: {
                type: "object",
                properties: {
                  ttlSeconds: { type: "integer", minimum: 30, maximum: 3600, default: 900 },
                },
                additionalProperties: false,
              },
            },
            {
              name: "playwright_pool.session.start",
              description:
                "Reserve a pool slot and create/select a dedicated tab. Use playwright_pool.session.call for subsequent commands to avoid tab spam.",
              inputSchema: {
                type: "object",
                properties: {
                  ttlSeconds: { type: "integer", minimum: 30, maximum: 3600, default: 900 },
                },
                additionalProperties: false,
              },
            },
            {
              name: "playwright_pool.session.call",
              description:
                "Run a Playwright tool inside a reserved session (auto-selects the session tab before calling).",
              inputSchema: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  tool: { type: "string", description: "Upstream tool name (e.g. browser_navigate)" },
                  arguments: { type: "object" },
                },
                required: ["sessionId", "tool"],
                additionalProperties: false,
              },
            },
            {
              name: "playwright_pool.session.end",
              description:
                "Close the session tab and release the reserved pool slot.",
              inputSchema: {
                type: "object",
                properties: { sessionId: { type: "string" } },
                required: ["sessionId"],
                additionalProperties: false,
              },
            },
            {
              name: "playwright_pool.release",
              description: "Release a previously reserved Playwright pool slot.",
              inputSchema: {
                type: "object",
                properties: { upstreamId: { type: "string" } },
                additionalProperties: false,
              },
            },
          ]
        : []),
      {
        name: "tailscale.devices.list",
        description:
          "List devices in a tailnet using the Tailscale v2 API (requires TAILSCALE_API_KEY).",
        inputSchema: {
          type: "object",
          properties: { tailnet: { type: "string", description: "Tailnet name or '-'" } },
          additionalProperties: false,
        },
      },
      {
        name: "tailscale.keys.createEphemeral",
        description:
          "Create an (optionally reusable) auth key for device registration (requires TAILSCALE_API_KEY).",
        inputSchema: {
          type: "object",
          properties: {
            tailnet: { type: "string", description: "Tailnet name or '-'" },
            tags: { type: "array", items: { type: "string" } },
            expirySeconds: { type: "integer" },
            reusable: { type: "boolean" },
            ephemeral: { type: "boolean" },
            preauthorized: { type: "boolean" },
            description: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "daytona.sandbox.create",
        description:
          "Create a Daytona sandbox (requires DAYTONA_API_KEY; uses env vars by default).",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string" },
            autoStopIntervalMinutes: { type: "integer", minimum: 0 },
            language: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "daytona.sandbox.delete",
        description: "Delete a Daytona sandbox by id.",
        inputSchema: {
          type: "object",
          properties: { sandboxId: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "daytona.process.exec",
        description: "Execute a shell command in a Daytona sandbox.",
        inputSchema: {
          type: "object",
          properties: { sandboxId: { type: "string" }, command: { type: "string" } },
          additionalProperties: false,
        },
      },
      ...routes.toolDefs,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResponse> => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === "health.ping") {
    healthPingInput.parse(args);
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: true,
            name: "mcpmanager-gateway",
            version: "0.1.0",
            now: new Date().toISOString(),
          }),
        },
      ],
    };
  }

  if (name === "mcpmanager.upstreams.list") {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            upstreams,
            errors: Object.fromEntries(upstreamErrors.entries()),
          }),
        },
      ],
    };
  }

  if (name === "mcpmanager.upstreams.reload") {
    await loadRegistry();
    return { content: [{ type: "text", text: asJsonText({ ok: true, upstreams }) }] };
  }

  if (name === "playwright_pool.list") {
    const status = await listPoolStatus(heldPlaywrightLeases);
    return { content: [{ type: "text", text: asJsonText({ pool: status }) }] };
  }

  if (name === "playwright_pool.reserve") {
    const ttlSeconds = Number((args as any)?.ttlSeconds ?? 900);
    const ttl = Number.isFinite(ttlSeconds) ? Math.min(Math.max(ttlSeconds, 30), 3600) : 900;

    const pool = configuredPoolIds();
    if (pool.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: "Playwright pool not configured. Set MCPMANAGER_PLAYWRIGHT_POOL=playwright1,playwright2",
            }),
          },
        ],
      };
    }

    for (const upstreamId of pool) {
      const acquired = await tryAcquireLock(upstreamId, ttl);
      if (acquired.ok) {
        heldPlaywrightLeases.add(upstreamId);
        await audit(name, { upstreamId, ttlSeconds: ttl }, { ok: true });
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: true,
                upstreamId,
                ttlSeconds: ttl,
                usage: `Call tools using the prefix: ${upstreamId}.<tool> (e.g. ${upstreamId}.browser_navigate).`,
              }),
            },
          ],
        };
      }
    }

    await audit(name, args, { ok: false, reason: "No free Playwright pool slots." });
    return { content: [{ type: "text", text: asJsonText({ ok: false, error: "No free pool slots." }) }] };
  }

  if (name === "playwright_pool.session.start") {
    const ttlSeconds = Number((args as any)?.ttlSeconds ?? 900);
    const ttl = Number.isFinite(ttlSeconds) ? Math.min(Math.max(ttlSeconds, 30), 3600) : 900;

    const pool = configuredPoolIds();
    if (pool.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error:
                "Playwright pool not configured. Set MCPMANAGER_PLAYWRIGHT_POOL=playwright1,playwright2",
            }),
          },
        ],
      };
    }

    for (const upstreamId of pool) {
      const acquired = await tryAcquireLock(upstreamId, ttl);
      if (!acquired.ok) continue;

      heldPlaywrightLeases.add(upstreamId);
      try {
        const { client } = await getUpstreamClient(upstreamId);

        // Create a dedicated tab and select it.
        await client.callTool({ name: "browser_tabs", arguments: { action: "new" } as any });
        const tabs = await client.callTool({
          name: "browser_tabs",
          arguments: { action: "list" } as any,
        });
        const tabsText = String((tabs as any)?.content?.[0]?.text ?? "");
        const re = /^-\s*(\d+):/gm;
        let tabIndex = 0;
        for (;;) {
          const m = re.exec(tabsText);
          if (!m) break;
          const idx = Number(m[1]);
          if (Number.isFinite(idx) && idx >= tabIndex) tabIndex = idx;
        }
        await client.callTool({
          name: "browser_tabs",
          arguments: { action: "select", index: tabIndex } as any,
        });

        const sessionId = randomUUID();
        playwrightSessions.set(sessionId, { upstreamId, tabIndex });
        await audit(name, { upstreamId, ttlSeconds: ttl, sessionId, tabIndex }, { ok: true });
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: true,
                sessionId,
                upstreamId,
                tabIndex,
                usage:
                  "Use playwright_pool.session.call with tool=browser_navigate/browser_click/... then playwright_pool.session.end.",
              }),
            },
          ],
        };
      } catch (e) {
        await audit(name, { upstreamId, error: String(e) }, { ok: false, reason: String(e) });
        heldPlaywrightLeases.delete(upstreamId);
        await releaseLock(upstreamId);
        return { content: [{ type: "text", text: asJsonText({ ok: false, error: String(e) }) }] };
      }
    }

    await audit(name, args, { ok: false, reason: "No free Playwright pool slots." });
    return { content: [{ type: "text", text: asJsonText({ ok: false, error: "No free pool slots." }) }] };
  }

  if (name === "playwright_pool.session.call") {
    const sessionId = String((args as any)?.sessionId ?? "");
    const tool = String((args as any)?.tool ?? "");
    const toolArgs = ((args as any)?.arguments ?? {}) as Record<string, unknown>;
    if (!sessionId || !tool) {
      return {
        content: [
          { type: "text", text: asJsonText({ ok: false, error: "sessionId and tool required" }) },
        ],
      };
    }

    const session = playwrightSessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "Unknown sessionId" }) }] };
    }
    if (!heldPlaywrightLeases.has(session.upstreamId)) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({ ok: false, error: "Session slot is not held by this process." }),
          },
        ],
      };
    }

    const { client } = await getUpstreamClient(session.upstreamId);
    // Always re-select the session tab before each call.
    await client.callTool({
      name: "browser_tabs",
      arguments: { action: "select", index: session.tabIndex } as any,
    });
    const res = await client.callTool({ name: tool, arguments: toolArgs as any });
    const content = (res as any)?.content;
    await audit(name, { sessionId, upstreamId: session.upstreamId, tool, toolArgs }, { ok: true });
    return { content: Array.isArray(content) ? content : [{ type: "text", text: "" }] };
  }

  if (name === "playwright_pool.session.end") {
    const sessionId = String((args as any)?.sessionId ?? "");
    if (!sessionId) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "sessionId required" }) }] };
    }
    const session = playwrightSessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "Unknown sessionId" }) }] };
    }
    const upstreamId = session.upstreamId;
    const held = heldPlaywrightLeases.has(upstreamId);
    try {
      if (held) {
        const { client } = await getUpstreamClient(upstreamId);
        await client.callTool({
          name: "browser_tabs",
          arguments: { action: "close", index: session.tabIndex } as any,
        });
      }
    } catch {
      // ignore cleanup errors
    }
    playwrightSessions.delete(sessionId);
    if (held) {
      await releaseLock(upstreamId);
      heldPlaywrightLeases.delete(upstreamId);
    }
    await audit(name, { sessionId, upstreamId }, { ok: true });
    return { content: [{ type: "text", text: asJsonText({ ok: true }) }] };
  }

  if (name === "playwright_pool.release") {
    const upstreamId = String((args as any)?.upstreamId ?? "");
    if (!upstreamId) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "upstreamId required" }) }] };
    }
    if (!heldPlaywrightLeases.has(upstreamId)) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({ ok: false, error: "Not held by this process." }),
          },
        ],
      };
    }
    await releaseLock(upstreamId);
    heldPlaywrightLeases.delete(upstreamId);
    await audit(name, { upstreamId }, { ok: true });
    return { content: [{ type: "text", text: asJsonText({ ok: true }) }] };
  }

  if (name === "tailscale.devices.list") {
    const input = tailscaleListDevicesInput.parse(args);
    const handle = getTailscale();
    const data = await listDevices(
      handle,
      input.tailnet ?? process.env.TAILSCALE_TAILNET ?? "-",
    );
    return { content: [{ type: "text", text: asJsonText(data) }] };
  }

  if (name === "tailscale.keys.createEphemeral") {
    const input = tailscaleCreateKeyInput.parse(args);
    const decision = checkPolicy(name, input);
    await audit(name, input, decision);
    if (!decision.ok) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: decision.reason }) }] };
    }
    const handle = getTailscale();
    const data = await createEphemeralKey(handle, {
      ...input,
      tailnet: input.tailnet ?? process.env.TAILSCALE_TAILNET ?? "-",
    });
    return { content: [{ type: "text", text: asJsonText(data) }] };
  }

  if (name === "daytona.sandbox.create") {
    const input = daytonaCreateSandboxInput.parse(args);
    await audit(name, input, { ok: true });
    const handle = getDaytona();
    const sandbox = await handle.createSandbox(input);
    return { content: [{ type: "text", text: asJsonText(sandbox) }] };
  }

  if (name === "daytona.sandbox.delete") {
    const input = daytonaDeleteSandboxInput.parse(args);
    await audit(name, input, { ok: true });
    const handle = getDaytona();
    await handle.deleteSandbox(input.sandboxId);
    return { content: [{ type: "text", text: asJsonText({ ok: true }) }] };
  }

  if (name === "daytona.process.exec") {
    const input = daytonaExecuteCommandInput.parse(args);
    await audit(name, input, { ok: true });
    const handle = getDaytona();
    const result = await handle.exec(input.sandboxId, input.command);
    return { content: [{ type: "text", text: asJsonText(result) }] };
  }

  const routes = await ensureToolRoutes();
  const route = routes.byToolName.get(name);
  if (route) {
    const { upstreamId, upstreamTool } = route;
    if (poolEnabled() && configuredPoolIds().includes(upstreamId) && !heldPlaywrightLeases.has(upstreamId)) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `Playwright slot '${upstreamId}' requires reservation. Call playwright_pool.reserve first.`,
            }),
          },
        ],
      };
    }
    await audit(name, { upstreamId, upstreamTool, args }, { ok: true });
    const { client } = await getUpstreamClient(upstreamId);
    const res = await client.callTool({ name: upstreamTool, arguments: args as any });
    const content = (res as any)?.content;
    return { content: Array.isArray(content) ? content : [{ type: "text", text: "" }] };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
});

await loadRegistry();

const transport = new StdioServerTransport();
await server.connect(transport);
