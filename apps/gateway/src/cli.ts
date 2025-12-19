import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";
import { readRegistry, type Upstream } from "./registry/registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type ShellResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cmd: string;
};

type InteractionRecord = {
  id: string;
  model?: string;
  agent?: string;
  input: unknown;
  outputs: Array<{
    type: string;
    text?: string;
    data?: string;
    mime_type?: string;
    name?: string;
    arguments?: unknown;
    id?: string;
  }>;
  previous_interaction_id?: string;
  status: "completed" | "failed" | "in_progress" | "requires_action";
  created_at: string;
  background?: boolean;
  usage?: unknown;
  session_id?: string;
  error?: { message: string; stderr?: string; exit_code?: number | null; timed_out?: boolean };
  raw?: unknown;
};

type InputPartText = { type: "text"; text: string };
type InputPartMedia = {
  type: "image" | "audio" | "video" | "document";
  data: string;
  mime_type?: string;
};
type InputPart = InputPartText | InputPartMedia;

type NormalizedInput =
  | { ok: true; kind: "text" | "content" | "turns"; prompt: string; parts: InputPart[]; hasNonText: boolean }
  | { ok: false; error: string };

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function interactionsDir(): string {
  return process.env.MCPMANAGER_INTERACTIONS_DIR ?? path.join(homeDir(), ".mcpmanager", "interactions");
}

function interactionPath(id: string): string {
  return path.join(interactionsDir(), `${id}.json`);
}

async function readInteraction(id: string): Promise<InteractionRecord | null> {
  try {
    const raw = await fs.readFile(interactionPath(id), "utf8");
    return JSON.parse(raw) as InteractionRecord;
  } catch {
    return null;
  }
}

async function writeInteraction(record: InteractionRecord): Promise<void> {
  const dir = interactionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(interactionPath(record.id), JSON.stringify(record, null, 2) + "\n", "utf8");
}

async function deleteInteraction(id: string): Promise<boolean> {
  try {
    await fs.unlink(interactionPath(id));
    return true;
  } catch {
    return false;
  }
}

function contentToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const v = value as any;
  const type = typeof v.type === "string" ? String(v.type) : "text";
  if (type === "text") {
    return typeof v.text === "string" ? v.text : null;
  }
  if (type === "function_result") {
    const name = typeof v.name === "string" ? v.name : "tool";
    const result = "result" in v ? v.result : v.content ?? v.output ?? v.value;
    const text = typeof result === "string" ? result : asJsonText(result);
    return `Tool result (${name}): ${text}`;
  }
  return null;
}

function normalizeContentPart(
  value: unknown,
): { ok: true; part: InputPart; hasNonText: boolean } | { ok: false; error: string } {
  if (typeof value === "string") {
    return { ok: true, part: { type: "text", text: value }, hasNonText: false };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, error: "invalid content part" };
  }
  const v = value as any;
  const type = typeof v.type === "string" ? String(v.type) : typeof v.text === "string" ? "text" : "";
  if (type === "text") {
    if (typeof v.text !== "string") return { ok: false, error: "text parts must include text" };
    return { ok: true, part: { type: "text", text: v.text }, hasNonText: false };
  }
  if (type === "function_result") {
    const name = typeof v.name === "string" ? v.name : "tool";
    const result = "result" in v ? v.result : v.content ?? v.output ?? v.value;
    const text = typeof result === "string" ? result : asJsonText(result);
    return { ok: true, part: { type: "text", text: `Tool result (${name}): ${text}` }, hasNonText: false };
  }
  if (type === "image" || type === "audio" || type === "video" || type === "document") {
    if (typeof v.data !== "string") {
      return { ok: false, error: `${type} parts must include data` };
    }
    const mimeType = typeof v.mime_type === "string" ? v.mime_type : undefined;
    return {
      ok: true,
      part: { type, data: v.data, ...(mimeType ? { mime_type: mimeType } : {}) },
      hasNonText: true,
    };
  }
  return { ok: false, error: `unsupported content type: ${type || "unknown"}` };
}

function promptFromParts(parts: InputPart[]): string {
  const textParts = parts
    .filter((part) => part.type === "text")
    .map((part) => (part as InputPartText).text);
  return textParts.join("\n");
}

function normalizeInput(input: unknown): NormalizedInput {
  if (typeof input === "string") {
    return { ok: true, kind: "text", prompt: input, parts: [{ type: "text", text: input }], hasNonText: false };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "input must be a string or array" };
  }

  const looksLikeTurns = input.every(
    (item) => item && typeof item === "object" && typeof (item as any).role === "string",
  );
  if (looksLikeTurns) {
    const turns: Array<{ role: string; text: string }> = [];
    for (const item of input as Array<any>) {
      const role = String(item.role);
      const content = item.content;
      if (typeof content === "string") {
        turns.push({ role, text: content });
        continue;
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          const text = contentToText(part);
          if (text === null) return { ok: false, error: "non-text content is not supported in turns" };
          parts.push(text);
        }
        turns.push({ role, text: parts.join("\n") });
        continue;
      }
      const text = contentToText(content);
      if (text === null) return { ok: false, error: "non-text content is not supported in turns" };
      turns.push({ role, text });
    }
    const prompt = turnsToPrompt(turns);
    return {
      ok: true,
      kind: "turns",
      prompt,
      parts: [{ type: "text", text: prompt }],
      hasNonText: false,
    };
  }

  const parts: InputPart[] = [];
  let hasNonText = false;
  for (const item of input as Array<any>) {
    const normalized = normalizeContentPart(item);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    parts.push(normalized.part);
    if (normalized.hasNonText) hasNonText = true;
  }
  const prompt = promptFromParts(parts);
  return { ok: true, kind: "content", prompt, parts, hasNonText };
}

function turnsToPrompt(turns: Array<{ role: string; text: string }>): string {
  return turns
    .map((turn) => {
      const role = turn.role.toLowerCase();
      const label = role === "user" ? "User" : role === "assistant" || role === "model" ? "Assistant" : turn.role;
      return `${label}: ${turn.text}`;
    })
    .join("\n");
}

type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

function partsToStreamContent(parts: InputPart[]): string | Array<Record<string, unknown>> {
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: part.type,
      data: part.data,
      ...(part.mime_type ? { mime_type: part.mime_type } : {}),
    };
  });
}

function normalizeTools(
  value: unknown,
): { ok: true; tools: ToolDefinition[] } | { ok: false; error: string } {
  if (value == null) return { ok: true, tools: [] };
  if (!Array.isArray(value)) return { ok: false, error: "tools must be an array" };
  const tools: ToolDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "tool entries must be objects" };
    const v = entry as any;
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (!name) return { ok: false, error: "tool entries must include a name" };
    const type = typeof v.type === "string" ? v.type : "function";
    if (type !== "function") return { ok: false, error: `unsupported tool type: ${type}` };
    const description = typeof v.description === "string" ? v.description : undefined;
    const parameters = v.parameters ?? undefined;
    tools.push({ name, description, parameters });
  }
  return { ok: true, tools };
}

function normalizeToolChoice(
  value: unknown,
  tools: ToolDefinition[],
): { ok: true; choice?: string } | { ok: false; error: string } {
  if (value == null) return { ok: true, choice: undefined };
  const byName = new Set(tools.map((tool) => tool.name));
  if (typeof value === "string") {
    const choice = value.trim();
    if (!choice) return { ok: true, choice: undefined };
    if (choice === "auto" || choice === "required" || choice === "none") return { ok: true, choice };
    if (!byName.has(choice)) return { ok: false, error: `Unknown tool_choice: ${choice}` };
    return { ok: true, choice };
  }
  if (typeof value === "object" && typeof (value as any).name === "string") {
    const choice = String((value as any).name).trim();
    if (!choice) return { ok: true, choice: undefined };
    if (!byName.has(choice)) return { ok: false, error: `Unknown tool_choice: ${choice}` };
    return { ok: true, choice };
  }
  return { ok: false, error: "tool_choice must be a string or { name }" };
}

function buildToolSchema(
  tools: ToolDefinition[],
  toolChoice?: string,
): { schema: unknown; requiresTool: boolean } | null {
  if (tools.length === 0 || toolChoice === "none") return null;
  const toolSchemas = tools.map((tool) => {
    const parameters = tool.parameters ?? { type: "object", properties: {} };
    return {
      type: "object",
      properties: {
        tool: { const: tool.name },
        arguments: parameters,
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    };
  });

  if (toolChoice && toolChoice !== "auto" && toolChoice !== "required") {
    const chosen = toolSchemas.find((schema) => (schema as any).properties?.tool?.const === toolChoice);
    return chosen ? { schema: chosen, requiresTool: true } : null;
  }

  if (toolChoice === "required") {
    return {
      schema: toolSchemas.length === 1 ? toolSchemas[0] : { oneOf: toolSchemas },
      requiresTool: true,
    };
  }

  const textVariant = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const variants = [...toolSchemas, textVariant];
  return {
    schema: variants.length === 1 ? variants[0] : { oneOf: variants },
    requiresTool: false,
  };
}

function buildToolInstructions(tools: ToolDefinition[], toolChoice?: string): string | undefined {
  if (tools.length === 0 || toolChoice === "none") return undefined;
  const heading = toolChoice === "required" ? "You must call one of these tools." : "Tools are available:";
  const toolLines = tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
  return [heading, ...toolLines].join("\n");
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [command, ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: "", stderr: message, exitCode: null, timedOut: false };
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? proc.stdout.text() : Promise.resolve(""),
    proc.stderr ? proc.stderr.text() : Promise.resolve(""),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return {
    ok: !timedOut && exitCode === 0,
    stdout,
    stderr,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    timedOut,
  };
}

async function runCommandWithInput(
  command: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [command, ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: "", stderr: message, exitCode: null, timedOut: false };
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  if (proc.stdin) {
    const stdinStream = proc.stdin as any;
    if (typeof stdinStream.write === "function") {
      const writeResult = stdinStream.write(stdinText);
      if (writeResult && typeof writeResult.then === "function") {
        await writeResult;
      }
      if (typeof stdinStream.end === "function") stdinStream.end();
    } else if (typeof stdinStream.getWriter === "function") {
      const writer = stdinStream.getWriter();
      try {
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(stdinText));
      } finally {
        await writer.close();
      }
    }
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? proc.stdout.text() : Promise.resolve(""),
    proc.stderr ? proc.stderr.text() : Promise.resolve(""),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return {
    ok: !timedOut && exitCode === 0,
    stdout,
    stderr,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    timedOut,
  };
}

function parseStreamJson(stdout: string): {
  events: any[];
  resultText?: string;
  structuredOutput?: unknown;
  usage?: unknown;
  sessionId?: string;
  error?: { message: string };
} {
  const events: any[] = [];
  let lastResult: any = null;
  let errorMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      events.push(evt);
      if (evt?.type === "result") {
        lastResult = evt;
      } else if (evt?.type === "error") {
        errorMessage = typeof evt?.error === "string" ? evt.error : JSON.stringify(evt?.error ?? evt);
      }
    } catch {
      events.push({ type: "raw", line: trimmed });
    }
  }

  let structuredOutput: unknown = undefined;
  let resultText: string | undefined;
  let usage: unknown = undefined;
  let sessionId: string | undefined = undefined;
  if (lastResult) {
    if (typeof lastResult.result === "string") resultText = lastResult.result;
    if ("structured_output" in lastResult) structuredOutput = lastResult.structured_output;
    if (lastResult.usage) usage = lastResult.usage;
    if (lastResult.modelUsage) usage = { ...(usage as any), modelUsage: lastResult.modelUsage };
    if (typeof lastResult.session_id === "string") sessionId = lastResult.session_id;
    if (lastResult.is_error && !errorMessage) {
      errorMessage =
        typeof lastResult.error === "string"
          ? lastResult.error
          : typeof lastResult.result === "string"
            ? lastResult.result
            : "Claude CLI error";
    }
  }

  return {
    events,
    resultText,
    structuredOutput,
    usage,
    sessionId,
    error: errorMessage ? { message: errorMessage } : undefined,
  };
}

function buildStreamInput(parts: InputPart[]): string {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: partsToStreamContent(parts),
    },
  };
  return `${JSON.stringify(message)}\n`;
}

async function runClaudeInteraction(options: {
  model?: string;
  agent?: string;
  systemInstruction?: string;
  prompt: string;
  parts: InputPart[];
  useStream: boolean;
  toolSchema?: { schema: unknown; requiresTool: boolean } | null;
  sessionId?: string;
  timeoutMs: number;
}): Promise<{
  outputs: InteractionRecord["outputs"];
  status: InteractionRecord["status"];
  usage?: unknown;
  sessionId?: string;
  raw?: unknown;
  error?: InteractionRecord["error"];
}> {
  if (!options.useStream) {
    const cliArgs = ["--print", "--output-format", "json"];
    if (options.model) cliArgs.push("--model", options.model);
    if (options.agent) cliArgs.push("--agent", options.agent);
    if (options.systemInstruction) cliArgs.push("--system-prompt", options.systemInstruction);
    if (options.sessionId) cliArgs.push("--session-id", options.sessionId);
    cliArgs.push(options.prompt);

    const run = await runCommand("claude", cliArgs, options.timeoutMs);
    let parsed: any = null;
    let outputs: InteractionRecord["outputs"] = [];
    let usage: unknown = undefined;
    let sessionFromCli: string | undefined = undefined;
    if (run.stdout.trim().length > 0) {
      try {
        parsed = JSON.parse(run.stdout);
        if (typeof parsed?.result === "string") {
          outputs = [{ type: "text", text: parsed.result }];
        }
        if (parsed?.usage) usage = parsed.usage;
        if (parsed?.modelUsage) usage = { ...(usage as any), modelUsage: parsed.modelUsage };
        if (typeof parsed?.session_id === "string") sessionFromCli = parsed.session_id;
      } catch {
        parsed = null;
      }
    }
    if (outputs.length === 0 && run.ok && run.stdout.trim().length > 0) {
      outputs = [{ type: "text", text: run.stdout }];
    }

    return {
      outputs,
      status: run.ok ? "completed" : "failed",
      usage,
      sessionId: sessionFromCli ?? options.sessionId,
      raw: parsed ?? { stdout: run.stdout, stderr: run.stderr, exit_code: run.exitCode },
      error: run.ok
        ? undefined
        : {
            message: run.stderr || "Claude CLI failed",
            stderr: run.stderr,
            exit_code: run.exitCode,
            timed_out: run.timedOut,
          },
    };
  }

  const cliArgs = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (options.model) cliArgs.push("--model", options.model);
  if (options.agent) cliArgs.push("--agent", options.agent);
  if (options.systemInstruction) cliArgs.push("--system-prompt", options.systemInstruction);
  if (options.sessionId) cliArgs.push("--session-id", options.sessionId);
  if (options.toolSchema) cliArgs.push("--json-schema", JSON.stringify(options.toolSchema.schema));

  const stdinText = buildStreamInput(options.parts);
  const run = await runCommandWithInput("claude", cliArgs, stdinText, options.timeoutMs);
  const parsed = parseStreamJson(run.stdout);
  const errorMessage = parsed.error?.message ?? (run.ok ? "" : run.stderr || "Claude CLI failed");

  let outputs: InteractionRecord["outputs"] = [];
  let status: InteractionRecord["status"] = "completed";
  if (parsed.structuredOutput !== undefined) {
    const structured = parsed.structuredOutput as any;
    if (structured && typeof structured === "object" && typeof structured.tool === "string") {
      outputs = [
        {
          type: "function_call",
          name: structured.tool,
          arguments: structured.arguments ?? {},
        },
      ];
      status = "requires_action";
    } else if (structured && typeof structured.text === "string") {
      outputs = [{ type: "text", text: structured.text }];
    } else if (typeof structured === "string") {
      outputs = [{ type: "text", text: structured }];
    } else if (structured != null) {
      outputs = [{ type: "text", text: asJsonText(structured) }];
    }
  }
  if (outputs.length === 0 && parsed.resultText) {
    outputs = [{ type: "text", text: parsed.resultText }];
  }

  if (!run.ok || parsed.error) {
    status = "failed";
  } else if (status !== "requires_action" && options.toolSchema?.requiresTool) {
    status = outputs.some((o) => o.type === "function_call") ? "requires_action" : status;
  }

  return {
    outputs,
    status,
    usage: parsed.usage,
    sessionId: parsed.sessionId ?? options.sessionId,
    raw: { stdout: run.stdout, stderr: run.stderr, exit_code: run.exitCode, events: parsed.events },
    error: !run.ok || parsed.error
      ? {
          message: errorMessage || "Claude CLI failed",
          stderr: run.stderr,
          exit_code: run.exitCode,
          timed_out: run.timedOut,
        }
      : undefined,
  };
}

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeArgArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}

function buildShellCommand(program: string, args: string[], stdin?: string): string {
  const base = [program, ...args].map(shellEscape).join(" ");
  if (!stdin) return base;
  return `printf %s ${shellEscape(stdin)} | ${base}`;
}

async function runShellCommand(cmd: string): Promise<ShellResult> {
  try {
    const result = await $`bash -lc ${cmd}`.quiet();
    const stdout = result.stdout ? Buffer.from(result.stdout).toString("utf8") : "";
    const stderr = result.stderr ? Buffer.from(result.stderr).toString("utf8") : "";
    const exitCode = typeof (result as any).exitCode === "number" ? (result as any).exitCode : 0;
    return { ok: true, stdout, stderr, exitCode, cmd };
  } catch (err) {
    const e = err as any;
    const stdout = e?.stdout ? Buffer.from(e.stdout).toString("utf8") : "";
    const stderr = e?.stderr
      ? Buffer.from(e.stderr).toString("utf8")
      : String(e?.message ?? e);
    const exitCode = typeof e?.exitCode === "number" ? e.exitCode : null;
    return { ok: false, stdout, stderr, exitCode, cmd };
  }
}

const server = new Server(
  { name: "mcpmanager-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

let upstreams: Upstream[] = [];
const upstreamClients = new Map<string, Client>();
const upstreamErrors = new Map<string, string>();
const heldPlaywrightLeases = new Set<string>();
const playwrightSessions = new Map<
  string,
  { upstreamId: string; tabIndex: number; sessionKey?: string }
>();
const playwrightSessionKeys = new Map<string, string>();
const backgroundJobs = new Map<string, Promise<void>>();
let toolRoutes:
  | {
      byToolName: Map<string, { upstreamId: string; upstreamTool: string }>;
      builtInNames: Set<string>;
      toolDefs: any[];
    }
  | null = null;

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
    "mcpmanager.upstreams.list",
    "mcpmanager.upstreams.reload",
    "playwright_pool.list",
    "playwright_pool.reserve",
    "playwright_pool.session.start",
    "playwright_pool.session.call",
    "playwright_pool.session.end",
    "playwright_pool.release",
    "llm.codex.exec",
    "llm.claude.exec",
    "interactions.create",
    "interactions.get",
    "interactions.delete",
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
        name: "mcpmanager.upstreams.list",
        description: "List enabled upstream MCP servers configured in ~/.mcpmanager/registry.json.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "mcpmanager.upstreams.reload",
        description: "Reload ~/.mcpmanager/registry.json and reconnect upstreams.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "llm.codex.exec",
        description: "Run the codex CLI via Bun shell and capture stdout/stderr.",
        inputSchema: {
          type: "object",
          properties: {
            args: { type: "array", items: { type: "string" } },
            stdin: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "llm.claude.exec",
        description: "Run the claude CLI via Bun shell and capture stdout/stderr.",
        inputSchema: {
          type: "object",
          properties: {
            args: { type: "array", items: { type: "string" } },
            stdin: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "interactions.create",
        description:
          "Create an interaction backed by the Claude CLI (supports tools, background runs, and basic multimodal inputs).",
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string" },
            agent: { type: "string" },
            input: {},
            previous_interaction_id: { type: "string" },
            system_instruction: { type: "string" },
            tools: { type: "array", items: { type: "object" } },
            tool_choice: {},
            background: { type: "boolean" },
            store: { type: "boolean", default: true },
            timeout_ms: { type: "integer", minimum: 1000 },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
      {
        name: "interactions.get",
        description: "Fetch a previously stored interaction by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "interactions.delete",
        description: "Delete a stored interaction by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
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
                  newTab: { type: "boolean", default: true },
                  sessionKey: { type: "string" },
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
      ...routes.toolDefs,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResponse> => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

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

  if (name === "llm.codex.exec" || name === "llm.claude.exec") {
    const cmdArgs = normalizeArgArray((args as any)?.args);
    const stdin = typeof (args as any)?.stdin === "string" ? String((args as any).stdin) : undefined;
    const program = name === "llm.codex.exec" ? "codex" : "claude";
    const cmd = buildShellCommand(program, cmdArgs, stdin);
    const result = await runShellCommand(cmd);
    return { content: [{ type: "text", text: asJsonText(result) }] };
  }

  if (name === "interactions.create") {
    const model = typeof (args as any)?.model === "string" ? String((args as any).model) : undefined;
    const agent = typeof (args as any)?.agent === "string" ? String((args as any).agent) : undefined;
    const input = (args as any)?.input;
    const previousId =
      typeof (args as any)?.previous_interaction_id === "string"
        ? String((args as any).previous_interaction_id)
        : undefined;
    const systemInstruction =
      typeof (args as any)?.system_instruction === "string"
        ? String((args as any).system_instruction)
        : undefined;
    const store = (args as any)?.store !== false;
    const background = (args as any)?.background === true;
    const timeoutMsRaw = (args as any)?.timeout_ms;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 1000
        ? Math.floor(timeoutMsRaw)
        : 20000;

    const toolNormalization = normalizeTools((args as any)?.tools);
    if (!toolNormalization.ok) {
      return {
        content: [{ type: "text", text: asJsonText({ ok: false, error: toolNormalization.error }) }],
      };
    }
    const tools = toolNormalization.tools;
    const toolChoiceNormalization = normalizeToolChoice((args as any)?.tool_choice, tools);
    if (!toolChoiceNormalization.ok) {
      return {
        content: [{ type: "text", text: asJsonText({ ok: false, error: toolChoiceNormalization.error }) }],
      };
    }
    const toolChoice = toolChoiceNormalization.choice;

    const normalized = normalizeInput(input);
    if (!normalized.ok) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: normalized.error }) }] };
    }

    if (background && !store) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({ ok: false, error: "background runs require store=true" }),
          },
        ],
      };
    }

    let sessionId: string | undefined;
    if (previousId) {
      const prev = await readInteraction(previousId);
      if (!prev) {
        return {
          content: [
            {
              type: "text",
              text: asJsonText({ ok: false, error: `Unknown previous_interaction_id: ${previousId}` }),
            },
          ],
        };
      }
      if (!prev.session_id) {
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: false,
                error: `previous_interaction_id ${previousId} has no session_id to resume`,
              }),
            },
          ],
        };
      }
      sessionId = prev.session_id;
    }

    const toolInstructions = buildToolInstructions(tools, toolChoice);
    const combinedSystemInstruction = [systemInstruction, toolInstructions].filter(Boolean).join("\n\n") || undefined;
    const toolSchema = buildToolSchema(tools, toolChoice);
    const useStream = normalized.hasNonText || Boolean(toolSchema);

    const baseInteraction: InteractionRecord = {
      id: randomUUID(),
      model,
      agent,
      input,
      outputs: [],
      previous_interaction_id: previousId,
      status: background ? "in_progress" : "completed",
      created_at: new Date().toISOString(),
      background,
      usage: undefined,
      session_id: sessionId,
    };

    const runInteraction = async (): Promise<InteractionRecord> => {
      const result = await runClaudeInteraction({
        model,
        agent,
        systemInstruction: combinedSystemInstruction,
        prompt: normalized.prompt,
        parts: normalized.parts,
        useStream,
        toolSchema,
        sessionId,
        timeoutMs,
      });
      return {
        ...baseInteraction,
        outputs: result.outputs,
        status: result.status,
        usage: result.usage,
        session_id: result.sessionId ?? sessionId,
        error: result.error,
        raw: result.raw,
      };
    };

    if (background) {
      if (store) {
        await writeInteraction(baseInteraction);
      }
      const job = runInteraction()
        .then(async (record) => {
          await writeInteraction(record);
        })
        .catch(() => {
          // ignore background failures (record may already contain error state).
        })
        .finally(() => {
          backgroundJobs.delete(baseInteraction.id);
        });
      backgroundJobs.set(baseInteraction.id, job);
      return { content: [{ type: "text", text: asJsonText(baseInteraction) }] };
    }

    const interaction = await runInteraction();
    if (store) {
      await writeInteraction(interaction);
    }
    return { content: [{ type: "text", text: asJsonText(interaction) }] };
  }

  if (name === "interactions.get") {
    const id = typeof (args as any)?.id === "string" ? String((args as any).id) : "";
    if (!id) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "id required" }) }] };
    }
    const record = await readInteraction(id);
    if (!record) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "not found" }) }] };
    }
    return { content: [{ type: "text", text: asJsonText(record) }] };
  }

  if (name === "interactions.delete") {
    const id = typeof (args as any)?.id === "string" ? String((args as any).id) : "";
    if (!id) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "id required" }) }] };
    }
    const ok = await deleteInteraction(id);
    return { content: [{ type: "text", text: asJsonText({ ok }) }] };
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

    return { content: [{ type: "text", text: asJsonText({ ok: false, error: "No free pool slots." }) }] };
  }

  if (name === "playwright_pool.session.start") {
    const ttlSeconds = Number((args as any)?.ttlSeconds ?? 900);
    const ttl = Number.isFinite(ttlSeconds) ? Math.min(Math.max(ttlSeconds, 30), 3600) : 900;
    const sessionKeyRaw = typeof (args as any)?.sessionKey === "string" ? String((args as any).sessionKey) : "";
    const sessionKey = sessionKeyRaw.trim().length > 0 ? sessionKeyRaw.trim() : null;
    const newTab =
      typeof (args as any)?.newTab === "boolean" ? Boolean((args as any).newTab) : true;

    if (sessionKey) {
      const existingId = playwrightSessionKeys.get(sessionKey);
      if (existingId) {
        const existing = playwrightSessions.get(existingId);
        if (existing && heldPlaywrightLeases.has(existing.upstreamId)) {
          return {
            content: [
              {
                type: "text",
                text: asJsonText({
                  ok: true,
                  sessionId: existingId,
                  upstreamId: existing.upstreamId,
                  tabIndex: existing.tabIndex,
                  reused: true,
                  usage:
                    "Use playwright_pool.session.call with tool=browser_navigate/browser_click/... then playwright_pool.session.end.",
                }),
              },
            ],
          };
        }
        playwrightSessionKeys.delete(sessionKey);
      }
    }

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

        if (newTab) {
          await client.callTool({ name: "browser_tabs", arguments: { action: "new" } as any });
        }
        const listTabs = async () => {
          const tabs = await client.callTool({
            name: "browser_tabs",
            arguments: { action: "list" } as any,
          });
          const tabsText = String((tabs as any)?.content?.[0]?.text ?? "");
          const re = /^-\s*(\d+):/gm;
          let maxIndex = -1;
          for (;;) {
            const m = re.exec(tabsText);
            if (!m) break;
            const idx = Number(m[1]);
            if (Number.isFinite(idx) && idx > maxIndex) maxIndex = idx;
          }
          return maxIndex;
        };
        let tabIndex = await listTabs();
        if (tabIndex < 0) {
          await client.callTool({ name: "browser_tabs", arguments: { action: "new" } as any });
          tabIndex = await listTabs();
        }
        if (tabIndex < 0) tabIndex = 0;
        await client.callTool({
          name: "browser_tabs",
          arguments: { action: "select", index: tabIndex } as any,
        });

        const sessionId = randomUUID();
        playwrightSessions.set(sessionId, { upstreamId, tabIndex, sessionKey: sessionKey ?? undefined });
        if (sessionKey) {
          playwrightSessionKeys.set(sessionKey, sessionId);
        }
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: true,
                sessionId,
                upstreamId,
                tabIndex,
                newTab,
                usage:
                  "Use playwright_pool.session.call with tool=browser_navigate/browser_click/... then playwright_pool.session.end.",
              }),
            },
          ],
        };
      } catch (e) {
        heldPlaywrightLeases.delete(upstreamId);
        await releaseLock(upstreamId);
        return { content: [{ type: "text", text: asJsonText({ ok: false, error: String(e) }) }] };
      }
    }

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
    if (session.sessionKey) {
      const mapped = playwrightSessionKeys.get(session.sessionKey);
      if (mapped === sessionId) {
        playwrightSessionKeys.delete(session.sessionKey);
      }
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
    return { content: [{ type: "text", text: asJsonText({ ok: true }) }] };
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
