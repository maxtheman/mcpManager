import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";
import { readRegistry, writeRegistry, registryPath as resolveRegistryPath, type Upstream } from "../infra/registry/registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configuredPoolIds,
  listPoolStatus,
  poolEnabled,
  releaseLock,
  parsePoolIds,
  setPoolIdsOverride,
  tryAcquireLock,
} from "../infra/playwright/pool.js";
import {
  deletePoolSessionMapping,
  loadPoolSessionMapping,
  savePoolSessionMapping,
} from "../infra/playwright/pool-session-state.js";
import { randomUUID } from "node:crypto";
import { validateSkills, formatValidationText } from "../core/skills/validator.js";
import { analyzeSkills, formatAnalysisText } from "../core/skills/analyzer.js";
import { syncFromSource } from "../core/sync.js";
import { sourceDir } from "../shared/source.js";
import { planPlaywrightPoolScale } from "../core/playwright-pool/scale.js";
import {
  PLAYWRIGHT_SESSION_TOOL_DEFS,
  handlePlaywrightSessionTool,
  isPlaywrightSessionTool,
} from "../core/playwright-sessions/mcp-tools.js";

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

type InteractionStatus = "in_progress" | "requires_action" | "completed" | "failed" | "cancelled";

type Interaction = {
  id: string;
  object: "interaction";
  status: InteractionStatus;
  model?: string;
  agent?: string;
  created?: string;
  updated?: string;
  role?: string;
  outputs?: InputPart[];
  system_instruction?: string;
  tools?: unknown[];
  background?: boolean;
  usage?: unknown;
  response_modalities?: string[];
  response_format?: unknown;
  response_mime_type?: string;
  previous_interaction_id?: string;
  input?: unknown;
  generation_config?: unknown;
  agent_config?: unknown;
};

type InteractionState = {
  interaction: Interaction;
  sessionKey: string;
  permissionless: boolean;
  store: boolean;
  cwd?: string;
};

type ModelCatalog = {
  updated_at: string;
  claude: {
    aliases: string[];
    models: string[];
    errors?: string[];
  };
  codex: {
    model?: string;
    reasoning_effort?: string;
    config_path?: string;
    errors?: string[];
  };
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

function modelsCachePath(): string {
  return process.env.MX_MODELS_CACHE_PATH ?? path.join(mxDir(), "models.json");
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean; originalLength: number } {
  if (value.length <= maxChars) return { text: value, truncated: false, originalLength: value.length };
  return {
    text: `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`,
    truncated: true,
    originalLength: value.length,
  };
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isToolNameSafe(name: string): boolean {
  return TOOL_NAME_RE.test(name);
}

function encodeToolNamePart(value: string): string {
  const input = String(value);
  if (input.length === 0) return "part";
  let out = "";
  for (const ch of input) {
    if (/[a-zA-Z0-9_-]/.test(ch)) {
      out += ch;
      continue;
    }
    const code = ch.codePointAt(0);
    out += `_x${(code ?? 0).toString(16)}_`;
  }
  return out.length > 0 ? out : "part";
}

function upstreamToolName(upstreamId: string, toolName: string): string {
  return `${encodeToolNamePart(upstreamId)}__${encodeToolNamePart(toolName)}`;
}

const TOOL_NAMES = {
  upstreamsList: "Mx_upstreams_list",
  upstreamsReload: "Mx_upstreams_reload",
  upstreamsSetEnabled: "Mx_upstreams_set_enabled",
  upstreamsSetActive: "Mx_upstreams_set_active",
  llmCodexExec: "llm_codex_exec",
  llmClaudeExec: "llm_claude_exec",
  llmModelsList: "llm_models_list",
  llmModelsRefresh: "llm_models_refresh",
  interactionsCreate: "interactions_create",
  interactionsGet: "interactions_get",
  interactionsCancel: "interactions_cancel",
  interactionsEvents: "interactions_events",
  interactionsWait: "interactions_wait",
  interactionsDelete: "interactions_delete",
  validateSkills: "validate-skills",
  analyzeSkills: "analyze-skills",
  sync: "Mx_sync",
  manageStart: "Mx_manage_start",
  playwrightPoolList: "playwright_pool_list",
  playwrightPoolStatus: "playwright_pool_status",
  playwrightPoolReserve: "playwright_pool_reserve",
  playwrightPoolSessionStart: "playwright_pool_session_start",
  playwrightPoolSessionCall: "playwright_pool_session_call",
  playwrightPoolSessionEnd: "playwright_pool_session_end",
  playwrightPoolRelease: "playwright_pool_release",
  playwrightPoolScale: "playwright_pool_scale",
} as const;

function normalizeToolName(name: string): string {
  return name;
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function mxDir(): string {
  return path.join(homeDir(), ".Mx");
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return undefined;
}

const interactionStore = new Map<string, InteractionState>();
const interactionEvents: Array<{
  id: number;
  interaction_id: string;
  status: InteractionStatus;
  updated: string;
  summary?: string;
}> = [];
let interactionEventCursor = 0;
const interactionWaiters = new Set<{
  cursor: number;
  limit: number;
  resolve: (payload: { events: typeof interactionEvents; next_cursor: number; timeout: boolean }) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}>();

const heldPlaywrightLeaseTtls = new Map<string, number>();

function getInteractionState(id: string): InteractionState | null {
  return interactionStore.get(id) ?? null;
}

function saveInteractionState(state: InteractionState): void {
  interactionStore.set(state.interaction.id, state);
}

function deleteInteractionState(id: string): boolean {
  return interactionStore.delete(id);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readInteraction(id: string): Interaction | null {
  return getInteractionState(id)?.interaction ?? null;
}

function writeInteraction(interaction: Interaction, state: Omit<InteractionState, "interaction">): void {
  saveInteractionState({ ...state, interaction });
}

function updateInteraction(id: string, updater: (interaction: Interaction) => Interaction): Interaction | null {
  const existing = getInteractionState(id);
  if (!existing) return null;
  const next = updater(existing.interaction);
  saveInteractionState({ ...existing, interaction: next });
  return next;
}

function summarizeInteractionOutput(interaction: Interaction): string | undefined {
  const first = interaction.outputs?.[0];
  if (!first || first.type !== "text") return undefined;
  const text = (first as InputPartText).text;
  if (!text) return undefined;
  return truncateText(text, 400).text;
}

function pushInteractionEvent(interaction: Interaction): void {
  interactionEventCursor += 1;
  interactionEvents.push({
    id: interactionEventCursor,
    interaction_id: interaction.id,
    status: interaction.status,
    updated: interaction.updated ?? nowIso(),
    summary: summarizeInteractionOutput(interaction),
  });
  if (interactionEvents.length > 200) {
    interactionEvents.shift();
  }
  if (interactionWaiters.size > 0) {
    const waiters = Array.from(interactionWaiters.values());
    for (const waiter of waiters) {
      if (interactionEventCursor <= waiter.cursor) continue;
      const payload = getEventsSince(waiter.cursor, waiter.limit);
      interactionWaiters.delete(waiter);
      if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
      waiter.resolve({ ...payload, timeout: false });
    }
  }
}

function getEventsSince(cursor: number, limit: number): { events: typeof interactionEvents; next_cursor: number } {
  const events = interactionEvents.filter((event) => event.id > cursor).slice(0, limit);
  const nextCursor = events.length > 0 ? events[events.length - 1].id : cursor;
  return { events, next_cursor: nextCursor };
}

function waitForInteractionEvent(cursor: number, limit: number, timeoutMs: number): Promise<{
  events: typeof interactionEvents;
  next_cursor: number;
  timeout: boolean;
}> {
  const existing = getEventsSince(cursor, limit);
  if (existing.events.length > 0) {
    return Promise.resolve({ ...existing, timeout: false });
  }
  return new Promise((resolve) => {
    const waiter = { cursor, limit, resolve } as {
      cursor: number;
      limit: number;
      resolve: (payload: { events: typeof interactionEvents; next_cursor: number; timeout: boolean }) => void;
      timeoutId?: ReturnType<typeof setTimeout>;
    };
    if (timeoutMs > 0) {
      waiter.timeoutId = setTimeout(() => {
        interactionWaiters.delete(waiter);
        resolve({ events: [], next_cursor: cursor, timeout: true });
      }, timeoutMs);
    }
    interactionWaiters.add(waiter);
  });
}

function getModelsCachePath(): string {
  return modelsCachePath();
}

async function readModelsCache(): Promise<ModelCatalog | null> {
  try {
    const raw = await fs.readFile(getModelsCachePath(), "utf8");
    return JSON.parse(raw) as ModelCatalog;
  } catch {
    return null;
  }
}

async function writeModelsCache(data: ModelCatalog): Promise<void> {
  const filePath = getModelsCachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function parseCodexConfigModel(text: string): { model?: string; reasoning_effort?: string } {
  const modelMatch = text.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  const effortMatch = text.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m);
  return {
    model: modelMatch ? modelMatch[1] : undefined,
    reasoning_effort: effortMatch ? effortMatch[1] : undefined,
  };
}

async function detectCodexModels(): Promise<ModelCatalog["codex"]> {
  const configPath = process.env.CODEX_CONFIG ?? path.join(homeDir(), ".codex", "config.toml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = parseCodexConfigModel(raw);
    return { ...parsed, config_path: configPath };
  } catch (error) {
    return { config_path: configPath, errors: [String(error)] };
  }
}

function parseJsonFromOutput(output: string): any | null {
  const lines = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep trying earlier lines
    }
  }
  return null;
}

async function detectClaudeModels(): Promise<ModelCatalog["claude"]> {
  const aliases = ["sonnet", "opus", "haiku"];
  const models = new Set<string>();
  const errors: string[] = [];
  for (const alias of aliases) {
    const cmd = buildShellCommand(
      "claude",
      ["--print", "--output-format", "json", "--model", alias, "--dangerously-skip-permissions"],
      "ping",
    );
    const result = await runShellCommand(cmd);
    if (!result.ok) {
      errors.push(`alias=${alias}: ${result.stderr || result.stdout || "unknown error"}`);
      continue;
    }
    const parsed = parseJsonFromOutput(result.stdout);
    if (parsed?.modelUsage && typeof parsed.modelUsage === "object") {
      for (const key of Object.keys(parsed.modelUsage)) {
        models.add(key);
      }
    }
  }
  return { aliases, models: Array.from(models.values()), errors: errors.length ? errors : undefined };
}

async function refreshModelsCache(): Promise<ModelCatalog> {
  const [claude, codex] = await Promise.all([detectClaudeModels(), detectCodexModels()]);
  const catalog: ModelCatalog = {
    updated_at: nowIso(),
    claude,
    codex,
  };
  await writeModelsCache(catalog);
  return catalog;
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
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const maybeTurn = input as { role?: unknown; content?: unknown };
    if (typeof maybeTurn.role === "string") {
      return normalizeInput([input]);
    }
    const normalized = normalizeContentPart(input);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const prompt = promptFromParts([normalized.part]);
    return { ok: true, kind: "content", prompt, parts: [normalized.part], hasNonText: normalized.hasNonText };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "input must be a string, content object, or array" };
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

function partsToStreamContent(parts: InputPart[]): string | Array<Record<string, unknown>> {
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const mediaType =
      part.mime_type ??
      (part.type === "image"
        ? "image/png"
        : part.type === "audio"
          ? "audio/wav"
          : part.type === "video"
            ? "video/mp4"
            : "application/pdf");
    return {
      type: part.type,
      source: {
        type: "base64",
        media_type: mediaType,
        data: part.data,
      },
    };
  });
}

async function readStreamText(stream: unknown): Promise<string> {
  if (!stream) return "";
  if (typeof stream === "number") return "";
  const maybeStream = stream as { text?: () => Promise<string> };
  if (typeof maybeStream.text === "function") {
    return maybeStream.text();
  }
  return "";
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

async function writeToStdin(stream: unknown, text: string): Promise<void> {
  if (!stream) return;
  const stdinStream = stream as any;
  if (typeof stdinStream.write === "function") {
    const writeResult = stdinStream.write(text);
    if (writeResult && typeof writeResult.then === "function") {
      await writeResult;
    }
    return;
  }
  if (typeof stdinStream.getWriter === "function") {
    const writer = stdinStream.getWriter();
    try {
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(text));
    } finally {
      await writer.close();
    }
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      yield line;
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

type SessionResult = {
  outputs: InputPart[];
  status: InteractionStatus;
  usage?: unknown;
  sessionId?: string;
  raw?: unknown;
  errorMessage?: string;
};

type SessionRequest = {
  interactionId: string;
  parts: InputPart[];
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
};

type ClaudeSession = {
  key: string;
  process: ReturnType<typeof Bun.spawn>;
  lineIterator: AsyncGenerator<string>;
  queue: SessionRequest[];
  busy: boolean;
  closed: boolean;
  sessionId?: string;
  model?: string;
  agent?: string;
  systemInstruction?: string;
  permissionless: boolean;
  cwd?: string;
  stderrText?: string;
};

const claudeSessions = new Map<string, ClaudeSession>();

function spawnClaudeSession(options: {
  key: string;
  model?: string;
  agent?: string;
  systemInstruction?: string;
  permissionless: boolean;
  cwd?: string;
}): ClaudeSession {
  const cliArgs = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (options.model) cliArgs.push("--model", options.model);
  if (options.agent) cliArgs.push("--agent", options.agent);
  if (options.systemInstruction) cliArgs.push("--system-prompt", options.systemInstruction);
  if (options.permissionless) cliArgs.push("--dangerously-skip-permissions");

  const proc = Bun.spawn({
    cmd: ["claude", ...cliArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    cwd: options.cwd,
  });

  const session: ClaudeSession = {
    key: options.key,
    process: proc,
    lineIterator: readLines(proc.stdout as ReadableStream<Uint8Array>),
    queue: [],
    busy: false,
    closed: false,
    sessionId: undefined,
    model: options.model,
    agent: options.agent,
    systemInstruction: options.systemInstruction,
    permissionless: options.permissionless,
    cwd: options.cwd,
    stderrText: undefined,
  };

  void (async () => {
    if (!proc.stderr) return;
    const stderrText = await readStreamText(proc.stderr);
    if (stderrText.trim().length > 0) session.stderrText = stderrText;
  })();

  void proc.exited.then(() => (session.closed = true));

  return session;
}

function closeClaudeSession(sessionKey: string, reason?: string): void {
  const session = claudeSessions.get(sessionKey);
  if (!session) return;
  session.closed = true;
  if (reason) {
    console.error(`[Mx] closing claude session ${sessionKey}: ${reason}`);
  }
  try {
    session.process.kill("SIGTERM");
  } catch {
    // ignore
  }
  claudeSessions.delete(sessionKey);
}

async function readSessionResult(session: ClaudeSession): Promise<{
  events: any[];
  resultText?: string;
  usage?: unknown;
  sessionId?: string;
  errorMessage?: string;
}> {
  const events: any[] = [];
  let lastResult: any = null;
  let errorMessage: string | undefined;
  let sessionId = session.sessionId;

  for await (const line of session.lineIterator) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      events.push(evt);
      if (evt?.type === "system" && evt?.subtype === "init" && typeof evt?.session_id === "string") {
        sessionId = evt.session_id;
        session.sessionId = sessionId;
      } else if (evt?.type === "error") {
        errorMessage =
          typeof evt?.error === "string" ? evt.error : JSON.stringify(evt?.error ?? evt);
      } else if (evt?.type === "result") {
        lastResult = evt;
        break;
      }
    } catch {
      events.push({ type: "raw", line: trimmed });
    }
  }

  if (!lastResult && session.closed) {
    return {
      events,
      sessionId,
      errorMessage: session.stderrText || "Claude CLI exited before returning a result.",
    };
  }

  let resultText: string | undefined;
  let usage: unknown = undefined;
  if (lastResult) {
    if (typeof lastResult.result === "string") resultText = lastResult.result;
    if (lastResult.usage) usage = lastResult.usage;
    if (lastResult.modelUsage) usage = { ...(usage as any), modelUsage: lastResult.modelUsage };
    if (typeof lastResult.session_id === "string") {
      sessionId = lastResult.session_id;
      session.sessionId = sessionId;
    }
    if (lastResult.is_error && !errorMessage) {
      errorMessage =
        typeof lastResult.error === "string"
          ? lastResult.error
          : typeof lastResult.result === "string"
            ? lastResult.result
            : "Claude CLI error";
    }
  }

  return { events, resultText, usage, sessionId, errorMessage };
}

async function runSessionRequest(session: ClaudeSession, request: SessionRequest): Promise<SessionResult> {
  if (session.closed) {
    throw new Error("Claude session is closed");
  }
  const stdinText = buildStreamInput(request.parts);
  await writeToStdin(session.process.stdin, stdinText);
  const parsed = await readSessionResult(session);
  const outputs: InputPart[] = parsed.resultText ? [{ type: "text", text: parsed.resultText }] : [];
  const status: InteractionStatus = parsed.errorMessage ? "failed" : "completed";
  return {
    outputs,
    status,
    usage: parsed.usage,
    sessionId: parsed.sessionId,
    raw: { events: parsed.events },
    errorMessage: parsed.errorMessage,
  };
}

function enqueueSessionRequest(session: ClaudeSession, request: SessionRequest): Promise<SessionResult> {
  return new Promise((resolve, reject) => {
    session.queue.push({ ...request, resolve, reject });
    if (!session.busy) {
      void processSessionQueue(session);
    }
  });
}

async function processSessionQueue(session: ClaudeSession): Promise<void> {
  if (session.busy) return;
  session.busy = true;
  while (session.queue.length > 0) {
    const next = session.queue.shift();
    if (!next) continue;
    try {
      const result = await runSessionRequest(session, next);
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  session.busy = false;
}

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
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

const server = new Server({ name: "Mx-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });

let upstreams: Upstream[] = [];
let registryUpstreams: Upstream[] = [];
let registryLoadError: string | null = null;
const upstreamClients = new Map<string, Client>();
const upstreamErrors = new Map<string, string>();
const heldPlaywrightLeases = new Set<string>();
const playwrightSessions = new Map<
  string,
  { upstreamId: string; tabIndex: number; sessionKey?: string }
>();
const playwrightSessionKeys = new Map<string, string>();
const backgroundJobs = new Map<string, Promise<void>>();
type ToolRoutes = {
  byToolName: Map<string, { upstreamId: string; upstreamTool: string }>;
  builtInNames: Set<string>;
  toolDefs: any[];
};
let toolRoutes: ToolRoutes | null = null;
let toolRoutesPromise: Promise<ToolRoutes> | null = null;

let upstreamSessionAllowlist: Set<string> | null = null;
let registryPlaywrightPoolConfig: any | null = null;

function parseIdList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function allowlistFromEnv(key: string): Set<string> | null {
  const raw = process.env[key];
  if (!raw || raw.trim().length === 0) return null;
  return new Set(parseIdList(raw));
}

function effectiveUpstreams(all: Upstream[]): Upstream[] {
  if (upstreamSessionAllowlist) {
    return all.filter((u) => upstreamSessionAllowlist?.has(u.id));
  }
  const envAllowlistRaw = process.env.MX_UPSTREAM_ALLOWLIST;
  if (envAllowlistRaw && envAllowlistRaw.trim().length > 0) {
    const allow = new Set(parseIdList(envAllowlistRaw));
    return all.filter((u) => allow.has(u.id));
  }
  return all.filter((u) => u.enabled);
}

async function loadRegistry() {
  registryLoadError = null;
  upstreamErrors.delete("_registry");
  toolRoutes = null;
  toolRoutesPromise = null;
  registryPlaywrightPoolConfig = null;

  try {
    const reg = await readRegistry();
    registryUpstreams = reg.upstreams;
    registryPlaywrightPoolConfig = (reg as any)?.playwright_pool ?? null;
    upstreams = effectiveUpstreams(registryUpstreams);
  } catch (e) {
    registryLoadError = `Failed to read registry at ${resolveRegistryPath()}: ${String(e)}`;
    registryUpstreams = [];
    upstreams = [];
    upstreamErrors.set("_registry", registryLoadError);
  }

  applyPlaywrightPoolConfig();
  upstreamErrors.clear();
  if (registryLoadError) upstreamErrors.set("_registry", registryLoadError);
  for (const [id, client] of upstreamClients.entries()) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    upstreamClients.delete(id);
  }
}

function upstreamLooksLikePlaywright(upstream: Upstream): boolean {
  const id = upstream.id.toLowerCase();
  if (id.includes("playwright")) return true;
  const haystack = [upstream.command, ...(upstream.args ?? [])].join(" ").toLowerCase();
  if (haystack.includes("@playwright/mcp")) return true;
  if (haystack.includes("playwright-mcp")) return true;
  if (haystack.includes("playwright") && haystack.includes("mcp")) return true;
  return false;
}

function applyPlaywrightPoolConfig() {
  const raw = process.env.MX_PLAYWRIGHT_POOL;
  const generator = registryPlaywrightPoolConfig;
  const generatorIds =
    generator && typeof generator === "object"
      ? (() => {
          const idPrefix =
            typeof generator.id_prefix === "string" && generator.id_prefix.trim().length > 0
              ? generator.id_prefix.trim()
              : "playwright";
          const count =
            typeof generator.count === "number" && Number.isFinite(generator.count)
              ? Math.max(0, Math.floor(generator.count))
              : 0;
          if (count <= 0) return [];
          const ids: string[] = [];
          for (let i = 1; i <= count; i += 1) ids.push(`${idPrefix}${i}`);
          return ids;
        })()
      : [];

  if (raw && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "auto") {
      const autoIds =
        generatorIds.length > 0
          ? generatorIds.filter((id) => upstreams.some((u) => u.id === id))
          : upstreams.filter(upstreamLooksLikePlaywright).map((u) => u.id);
      setPoolIdsOverride(autoIds);
      return;
    }
    if (normalized === "off" || normalized === "none" || normalized === "0") {
      setPoolIdsOverride([]);
      return;
    }
    setPoolIdsOverride(parsePoolIds(raw));
    return;
  }
  if (generatorIds.length > 0) {
    setPoolIdsOverride(generatorIds.filter((id) => upstreams.some((u) => u.id === id)));
    return;
  }
  const detected = upstreams.filter(upstreamLooksLikePlaywright).map((u) => u.id);
  setPoolIdsOverride(detected);
}

function buildManagementSystemInstruction(sourceRoot: string, repoDir?: string): string {
  const registryPath = path.join(sourceRoot, "registry.json");
  const skillsPath = path.join(sourceRoot, "skills");
  const commandsPath = path.join(sourceRoot, "commands");
  const projectCommands = repoDir ? path.join(repoDir, ".claude", "commands") : null;
  return [
    "You are managing MCP servers, skills, and commands for Mx.",
    `Source root: ${sourceRoot}`,
    `Registry: ${registryPath}`,
    `Skills: ${skillsPath}`,
    `Commands: ${commandsPath} (claude/global, claude/project, codex)`,
    projectCommands ? `Project commands dir: ${projectCommands}` : "Project commands dir: (not set)",
    "Preferred workflow:",
    "- Edit source-of-truth files (registry.json, skills/, commands/).",
    `- Use ${TOOL_NAMES.sync} to apply changes to user config.`,
    `- For project commands, pass repo_dir to ${TOOL_NAMES.sync} with command_scope=project.`,
  ].join("\n");
}

async function handleInteractionsCreate(
  args: Record<string, unknown>,
  overrides?: { systemInstructionPrefix?: string; allowMissingModel?: boolean },
): Promise<ToolResponse> {
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
  const tools = (args as any)?.tools;
  const responseModalities = Array.isArray((args as any)?.response_modalities)
    ? (args as any).response_modalities.filter((item: unknown) => typeof item === "string")
    : undefined;
  const responseFormat = (args as any)?.response_format;
  const responseMimeType =
    typeof (args as any)?.response_mime_type === "string" ? String((args as any).response_mime_type) : undefined;
  const generationConfig = (args as any)?.generation_config;
  const agentConfig = (args as any)?.agent_config;
  const stream = (args as any)?.stream === true;
  const background = (args as any)?.background === true;
  const store = (args as any)?.store !== false;
  const cwdRaw = typeof (args as any)?.cwd === "string" ? String((args as any).cwd).trim() : "";
  let cwd = cwdRaw.length > 0 ? path.resolve(cwdRaw) : undefined;
  const envSkipPermissions = parseOptionalBool(process.env.MX_INTERACTIONS_SKIP_PERMISSIONS);
  const permissionlessArg = (args as any)?.permissionless;
  const dangerousArg = (args as any)?.dangerously_skip_permissions;
  const permissionless =
    typeof permissionlessArg === "boolean"
      ? permissionlessArg
      : typeof dangerousArg === "boolean"
        ? dangerousArg
        : typeof envSkipPermissions === "boolean"
          ? envSkipPermissions
          : true;
  const dangerouslySkipPermissions = permissionless === true;

  const normalized = normalizeInput(input);
  if (!normalized.ok) {
    return { content: [{ type: "text", text: asJsonText({ ok: false, error: normalized.error }) }] };
  }

  if (model && agent) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({ ok: false, error: "Provide either model or agent, not both." }),
        },
      ],
    };
  }

  if (!previousId && !model && !agent && !overrides?.allowMissingModel) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({ ok: false, error: "model or agent is required." }),
        },
      ],
    };
  }

  if (tools != null && (!Array.isArray(tools) || tools.length > 0)) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: false,
            error: "tools are not supported; Claude CLI manages tools directly.",
          }),
        },
      ],
    };
  }

  if (stream) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: false,
            error: "stream is not supported; use background mode and poll with interactions_get.",
          }),
        },
      ],
    };
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

  let sessionKey: string | undefined;
  let existingState: InteractionState | null = null;
  if (previousId) {
    const prev = getInteractionState(previousId);
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
    if (prev.interaction.status === "in_progress") {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `previous_interaction_id ${previousId} is still in progress; wait for completion before resuming`,
            }),
          },
        ],
      };
    }
    if (!prev.sessionKey) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `previous_interaction_id ${previousId} has no session to resume`,
            }),
          },
        ],
      };
    }
    existingState = prev;
    sessionKey = prev.sessionKey;
    if (!cwd && prev.cwd) cwd = prev.cwd;
    if (prev.interaction.model && model && prev.interaction.model !== model) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `model mismatch for previous_interaction_id ${previousId}`,
            }),
          },
        ],
      };
    }
    if (prev.interaction.agent && agent && prev.interaction.agent !== agent) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `agent mismatch for previous_interaction_id ${previousId}`,
            }),
          },
        ],
      };
    }
    if (prev.permissionless !== permissionless) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: "permissionless must match the existing session",
            }),
          },
        ],
      };
    }
  }

  if (cwd) {
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) {
        return {
          content: [
            {
              type: "text",
              text: asJsonText({ ok: false, error: `cwd is not a directory: ${cwd}` }),
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({ ok: false, error: `cwd not found: ${cwd}` }),
          },
        ],
      };
    }
  }

  const combinedSystemInstruction =
    overrides?.systemInstructionPrefix != null
      ? [overrides.systemInstructionPrefix, systemInstruction].filter(Boolean).join("\n\n")
      : systemInstruction || undefined;

  if (existingState && existingState.interaction.system_instruction !== combinedSystemInstruction) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: false,
            error: "system_instruction must match the existing session",
          }),
        },
      ],
    };
  }

  const modelFinal = existingState?.interaction.model ?? model;
  const agentFinal = existingState?.interaction.agent ?? agent;
  const systemInstructionFinal = existingState?.interaction.system_instruction ?? combinedSystemInstruction;

  if (!modelFinal && !agentFinal && !overrides?.allowMissingModel) {
    return {
      content: [
        {
          type: "text",
          text: asJsonText({ ok: false, error: "model or agent is required." }),
        },
      ],
    };
  }

  if (!sessionKey) sessionKey = randomUUID();

  const created = nowIso();
  const baseInteraction: Interaction = {
    id: randomUUID(),
    object: "interaction",
    status: background ? "in_progress" : "completed",
    model: modelFinal,
    agent: agentFinal,
    created,
    updated: created,
    role: "assistant",
    outputs: [],
    system_instruction: systemInstructionFinal,
    tools: Array.isArray(tools) ? tools : undefined,
    background,
    response_modalities: responseModalities,
    response_format: responseFormat,
    response_mime_type: responseMimeType,
    previous_interaction_id: previousId,
    input,
    generation_config: generationConfig,
    agent_config: agentConfig,
  };

  const runInteraction = async (): Promise<Interaction> => {
    let session = claudeSessions.get(sessionKey as string);
    if (!session) {
      if (existingState) {
        throw new Error("Session is not active; cannot resume previous_interaction_id.");
      }
      session = spawnClaudeSession({
        key: sessionKey as string,
        model: modelFinal,
        agent: agentFinal,
        systemInstruction: systemInstructionFinal,
        permissionless: dangerouslySkipPermissions,
        cwd,
      });
      claudeSessions.set(sessionKey as string, session);
    } else if (session.closed) {
      throw new Error("Claude session is closed.");
    }

    const result = await enqueueSessionRequest(session, {
      interactionId: baseInteraction.id,
      parts: normalized.parts,
      resolve: () => undefined as unknown as SessionResult,
      reject: () => undefined as unknown as SessionResult,
    } as SessionRequest);
    const errorText = result.errorMessage ? `Error: ${result.errorMessage}` : undefined;
    return {
      ...baseInteraction,
      status: result.status,
      outputs: errorText ? [{ type: "text", text: errorText }] : result.outputs,
      usage: result.usage,
      updated: nowIso(),
    };
  };

  if (background) {
    if (store) {
      writeInteraction(baseInteraction, { sessionKey, permissionless, store, cwd });
    }
    const job = runInteraction()
      .then(async (record) => {
        const current = getInteractionState(baseInteraction.id);
        if (!current || current.interaction.status === "cancelled") return undefined;
        writeInteraction(record, { sessionKey, permissionless, store, cwd });
        pushInteractionEvent(record);
        return undefined;
      })
      .catch((error) => {
        const current = getInteractionState(baseInteraction.id);
        if (!current || current.interaction.status === "cancelled") return undefined;
        const failure: Interaction = {
          ...baseInteraction,
          status: "failed",
          outputs: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          updated: nowIso(),
        };
        writeInteraction(failure, { sessionKey, permissionless, store, cwd });
        pushInteractionEvent(failure);
        return undefined;
      })
      .finally(() => {
        backgroundJobs.delete(baseInteraction.id);
      });
    backgroundJobs.set(baseInteraction.id, job);
    return { content: [{ type: "text", text: asJsonText(baseInteraction) }] };
  }

  try {
    const interaction = await runInteraction();
    if (store) {
      writeInteraction(interaction, { sessionKey, permissionless, store, cwd });
    } else if (!previousId) {
      closeClaudeSession(sessionKey, "store=false interaction completed");
    }
    pushInteractionEvent(interaction);
    return { content: [{ type: "text", text: asJsonText(interaction) }] };
  } catch (error) {
    const failure: Interaction = {
      ...baseInteraction,
      status: "failed",
      outputs: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      updated: nowIso(),
    };
    if (store) {
      writeInteraction(failure, { sessionKey, permissionless, store, cwd });
    } else if (!previousId) {
      closeClaudeSession(sessionKey, "store=false interaction failed");
    }
    pushInteractionEvent(failure);
    return { content: [{ type: "text", text: asJsonText(failure) }] };
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
  const client = new Client({ name: `Mx-upstream-${upstreamId}`, version: "0.1.0" }, { capabilities: {} });
  try {
    const connectTimeoutMs = Number(process.env.MX_UPSTREAM_CONNECT_TIMEOUT_MS ?? 2000);
    await withRetries(
      () => withTimeout(client.connect(transport), connectTimeoutMs, `connect:${upstreamId}`),
      { retries: 2, baseDelayMs: 100, label: `connect:${upstreamId}` },
    );
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

async function ensureToolRoutes(): Promise<ToolRoutes> {
  if (toolRoutes) return toolRoutes;
  if (toolRoutesPromise) return toolRoutesPromise;

  toolRoutesPromise = (async () => {
    const builtInNames = new Set<string>(Object.values(TOOL_NAMES));
    const timeoutMs = Number(process.env.MX_UPSTREAM_LIST_TIMEOUT_MS ?? 2000);
    const listRetries = Number(process.env.MX_UPSTREAM_LIST_RETRIES ?? 2);

    const toolNameCounts = new Map<string, number>();
    const upstreamToolDefs: Array<{ upstreamId: string; tool: any }> = [];

    for (const upstream of upstreams) {
      try {
        const { client } = await withTimeout(getUpstreamClient(upstream.id), timeoutMs, `connect:${upstream.id}`);
        const list = await withRetries(
          () => withTimeout(client.listTools(), timeoutMs, `listTools:${upstream.id}`),
          { retries: Number.isFinite(listRetries) ? Math.max(0, Math.floor(listRetries)) : 2, baseDelayMs: 100, label: `listTools:${upstream.id}` },
        );
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
      // Always expose a prefixed name (Codex-safe) and keep a legacy dotted alias for compatibility.
      byToolName.set(upstreamToolName(upstreamId, tool.name), { upstreamId, upstreamTool: tool.name });
      byToolName.set(`${upstreamId}.${tool.name}`, { upstreamId, upstreamTool: tool.name });
    }

    // Also expose unprefixed aliases when unique and not colliding with built-ins.
    for (const { upstreamId, tool } of upstreamToolDefs) {
      if (builtInNames.has(tool.name)) continue;
      if ((toolNameCounts.get(tool.name) ?? 0) !== 1) continue;
      if (!isToolNameSafe(tool.name)) continue;
      if (!byToolName.has(tool.name)) {
        byToolName.set(tool.name, { upstreamId, upstreamTool: tool.name });
      }
    }

    const toolDefs: any[] = [];
    for (const { upstreamId, tool } of upstreamToolDefs) {
      toolDefs.push({ ...tool, name: upstreamToolName(upstreamId, tool.name) });
    }
    for (const { tool } of upstreamToolDefs) {
      if (builtInNames.has(tool.name)) continue;
      if ((toolNameCounts.get(tool.name) ?? 0) !== 1) continue;
      if (!isToolNameSafe(tool.name)) continue;
      toolDefs.push({ ...tool, name: tool.name });
    }

    const routes: ToolRoutes = { byToolName, builtInNames, toolDefs };
    toolRoutes = routes;
    return routes;
  })();

  return toolRoutesPromise;
}

function ensureToolRoutesBackground() {
  if (toolRoutes || toolRoutesPromise) return;
  void ensureToolRoutes().catch(() => null);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms (${label})`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
        return undefined;
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
        return undefined;
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number; label: string },
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= opts.retries) break;
      const backoff = opts.baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * Math.min(50, opts.baseDelayMs));
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

async function callUpstreamTool(params: {
  upstreamId: string;
  tool: string;
  arguments: Record<string, unknown>;
  label?: string;
  timeoutMs?: number;
}): Promise<any> {
  const callTimeoutMs = Number(process.env.MX_UPSTREAM_CALL_TIMEOUT_MS ?? 20000);
  const connectTimeoutMs = Number(process.env.MX_UPSTREAM_CONNECT_TIMEOUT_MS ?? 2000);
  const timeoutMs = Number.isFinite(params.timeoutMs ?? NaN) ? Number(params.timeoutMs) : callTimeoutMs;
  const label = params.label ?? `${params.upstreamId}.${params.tool}`;

  // If this process is holding a pool lease for this upstream, refresh TTL on each use so
  // locks auto-expire after inactivity (default 15 minutes) without wedging long-running sessions.
  if (heldPlaywrightLeases.has(params.upstreamId)) {
    const ttlSeconds = heldPlaywrightLeaseTtls.get(params.upstreamId) ?? 900;
    try {
      await tryAcquireLock(params.upstreamId, ttlSeconds);
    } catch {
      // ignore refresh errors; the call below may still succeed, but the slot could be stolen later.
    }
  }

  const attemptOnce = async () => {
    const { client } = await withTimeout(
      getUpstreamClient(params.upstreamId),
      connectTimeoutMs,
      `connect:${params.upstreamId}`,
    );
    return withTimeout(
      client.callTool({ name: params.tool, arguments: params.arguments as any }),
      timeoutMs,
      `callTool:${label}`,
    );
  };

  try {
    return await attemptOnce();
  } catch (e) {
    upstreamErrors.set(params.upstreamId, String(e));
    const existing = upstreamClients.get(params.upstreamId);
    if (existing) {
      try {
        await existing.close();
      } catch {
        // ignore
      }
      upstreamClients.delete(params.upstreamId);
    }
    // One retry after forced reconnect.
    return attemptOnce();
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    if (!toolRoutes) ensureToolRoutesBackground();
    const routes = toolRoutes ?? { builtInNames: new Set<string>(Object.values(TOOL_NAMES)), toolDefs: [] };
    const builtinAllowlist = allowlistFromEnv("MX_BUILTIN_ALLOWLIST");
    const filterBuiltins = (tools: any[]) => {
      if (!builtinAllowlist) return tools;
      return tools.filter((tool) => {
        const name = typeof tool?.name === "string" ? String(tool.name) : "";
        if (!routes.builtInNames.has(name)) return true;
        return builtinAllowlist.has(name);
      });
    };
    return {
      tools: filterBuiltins([
      {
        name: TOOL_NAMES.upstreamsList,
        description: "List enabled upstream MCP servers configured in ~/.Mx/registry.json.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_NAMES.upstreamsReload,
        description: "Reload ~/.Mx/registry.json and reconnect upstreams.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_NAMES.upstreamsSetEnabled,
        description:
          "Enable/disable upstream MCP servers in ~/.Mx/registry.json (takes effect after reload).",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Upstream ids to update." },
            enabled: { type: "boolean", description: "Whether the upstreams should be enabled." },
            dry_run: { type: "boolean", description: "If true, do not write changes." },
            reload: { type: "boolean", description: "If true (default), reload upstreams after writing." },
          },
          required: ["ids", "enabled"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.upstreamsSetActive,
        description:
          "Session-only upstream allowlist. Controls which upstream tools are exposed for this gateway process (resets on restart).",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["replace", "merge", "clear"],
              description:
                "replace: set allowlist exactly; merge: add/remove from current effective set; clear: revert to registry/env defaults.",
            },
            active_ids: {
              type: "array",
              items: { type: "string" },
              description: "Upstream ids to allow (replace mode). Empty disables all upstreams.",
            },
            enable_ids: {
              type: "array",
              items: { type: "string" },
              description: "Upstream ids to add (merge mode).",
            },
            disable_ids: {
              type: "array",
              items: { type: "string" },
              description: "Upstream ids to remove (merge mode).",
            },
            dry_run: { type: "boolean", description: "If true, do not change session state." },
            reload: { type: "boolean", description: "If true (default), reload upstreams after update." },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.llmCodexExec,
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
        name: TOOL_NAMES.llmClaudeExec,
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
        name: TOOL_NAMES.llmModelsList,
        description: "List cached model strings discovered for Claude/Codex CLIs.",
        inputSchema: {
          type: "object",
          properties: {
            refresh: { type: "boolean", description: "If true, refresh cache before returning." },
            ttlSeconds: { type: "integer", minimum: 0, description: "Treat cache stale after N seconds." },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.llmModelsRefresh,
        description: "Refresh cached model strings discovered for Claude/Codex CLIs.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: TOOL_NAMES.interactionsCreate,
        description: "Create an interaction backed by the Claude CLI (text in/out, optional multimodal inputs).",
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string" },
            agent: { type: "string" },
            input: {},
            cwd: {
              type: "string",
              description: "Working directory for the underlying CLI session (defaults to current process cwd).",
            },
            id: { type: "string" },
            status: { type: "string" },
            created: { type: "string" },
            updated: { type: "string" },
            role: { type: "string" },
            outputs: { type: "array", items: {} },
            usage: {},
            previous_interaction_id: { type: "string" },
            system_instruction: { type: "string" },
            tools: { type: "array", items: { type: "object" } },
            background: { type: "boolean" },
            store: { type: "boolean", default: true },
            stream: { type: "boolean" },
            response_modalities: { type: "array", items: { type: "string" } },
            response_format: {},
            response_mime_type: { type: "string" },
            generation_config: {},
            agent_config: {},
            permissionless: {
              type: "boolean",
              default: true,
              description: "Auto-enable permissionless mode (maps to dangerously_skip_permissions).",
            },
            dangerously_skip_permissions: {
              type: "boolean",
              description: "Skip CLI tool approval prompts (dangerous; recommended for background runs).",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.interactionsGet,
        description: "Fetch a previously stored interaction by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.interactionsEvents,
        description: "Fetch recent interaction completion events for background monitoring.",
        inputSchema: {
          type: "object",
          properties: {
            cursor: { type: "integer", minimum: 0, description: "Last seen event id." },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.interactionsWait,
        description: "Wait for the next interaction event (long-poll).",
        inputSchema: {
          type: "object",
          properties: {
            cursor: { type: "integer", minimum: 0, description: "Last seen event id." },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 1 },
            timeout_ms: { type: "integer", minimum: 0, description: "Wait up to N ms (0 disables timeout)." },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.interactionsCancel,
        description: "Cancel a stored interaction by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.interactionsDelete,
        description: "Delete a stored interaction by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.validateSkills,
        description: "Validate skills for Claude Code and Codex CLI compatibility.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["codex", "claude", "both"], default: "both" },
            autofix: { type: "boolean", default: false },
            backup: { type: "boolean", default: false },
            errors_only: { type: "boolean", default: false },
            format: { type: "string", enum: ["text", "json"], default: "text" },
            skill_dir: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.analyzeSkills,
        description: "Analyze skill directories for size and frontmatter coverage.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["codex", "claude", "both"], default: "both" },
            format: { type: "string", enum: ["text", "json"], default: "text" },
            skill_dir: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.sync,
        description: "Sync registry, skills, and commands from the MCP source directory into their target locations.",
        inputSchema: {
          type: "object",
          properties: {
            source_dir: { type: "string" },
            sync_registry: { type: "boolean", default: true },
            sync_skills: { type: "boolean", default: true },
            sync_commands: { type: "boolean", default: true },
            backup: { type: "boolean", default: false },
            dry_run: { type: "boolean", default: false },
            skill_target: { type: "string", enum: ["codex", "claude", "both"], default: "both" },
            prune_skills: { type: "boolean", default: false },
            command_target: { type: "string", enum: ["codex", "claude", "both"], default: "both" },
            command_scope: { type: "string", enum: ["global", "project", "both"], default: "global" },
            repo_dir: { type: "string" },
            prune_commands: { type: "boolean", default: false },
          },
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.manageStart,
        description: "Start a managed Claude CLI session for adding MCP servers, skills, and commands.",
        inputSchema: {
          type: "object",
          properties: {
            input: {},
            cwd: { type: "string" },
            repo_dir: { type: "string" },
            source_dir: { type: "string" },
            previous_interaction_id: { type: "string" },
            system_instruction: { type: "string" },
            tools: { type: "array", items: { type: "object" } },
            background: { type: "boolean" },
            store: { type: "boolean", default: true },
            stream: { type: "boolean" },
            response_modalities: { type: "array", items: { type: "string" } },
            response_format: {},
            response_mime_type: { type: "string" },
            generation_config: {},
            agent_config: {},
            permissionless: {
              type: "boolean",
              default: true,
              description: "Auto-enable permissionless mode (maps to dangerously_skip_permissions).",
            },
            dangerously_skip_permissions: {
              type: "boolean",
              description: "Skip CLI tool approval prompts (dangerous; recommended for background runs).",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
      {
        name: TOOL_NAMES.playwrightPoolScale,
        description:
          "Scale Playwright pool capacity by cloning a template upstream into N numbered upstreams (e.g. playwright1..playwrightN) in ~/.Mx/registry.json.",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 0, description: "Desired number of Playwright slots." },
            templateUpstreamId: {
              type: "string",
              description: "Template upstream id to clone (default: playwright).",
            },
            idPrefix: {
              type: "string",
              description: "Prefix for cloned ids (default: playwright).",
            },
            prune: {
              type: "boolean",
              default: false,
              description: "If true, remove clones above count; otherwise disable them.",
            },
            dry_run: { type: "boolean", default: false, description: "If true, do not write changes." },
            reload: { type: "boolean", default: true, description: "If true (default), reload upstreams after writing." },
          },
          required: ["count"],
          additionalProperties: false,
        },
      },
      ...(poolEnabled()
        ? [
            {
              name: TOOL_NAMES.playwrightPoolList,
              description:
                "List Playwright pool slots (1 slot per upstream id) and lock status. Pool ids come from MX_PLAYWRIGHT_POOL (comma list, 'auto', or 'off'); locks live in ~/.Mx/locks.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: TOOL_NAMES.playwrightPoolStatus,
              description:
                "Detailed Playwright pool status (locks, pid liveness, drift vs registry generator config).",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: TOOL_NAMES.playwrightPoolReserve,
              description:
                "Reserve one Playwright upstream slot for this gateway process (exclusive lock across processes). To increase concurrency, add more Playwright upstreams and include their ids in MX_PLAYWRIGHT_POOL (or use 'auto' with playwright-ish ids).",
              inputSchema: {
                type: "object",
                properties: {
                  ttlSeconds: { type: "integer", minimum: 30, maximum: 3600, default: 900 },
                },
                additionalProperties: false,
              },
            },
            {
              name: TOOL_NAMES.playwrightPoolSessionStart,
              description:
                `Reserve a slot and create/select a dedicated tab. Use ${TOOL_NAMES.playwrightPoolSessionCall} for subsequent commands to avoid tab spam; end with ${TOOL_NAMES.playwrightPoolSessionEnd} to close the tab + release the slot.`,
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
              name: TOOL_NAMES.playwrightPoolSessionCall,
              description:
                "Run an upstream Playwright tool inside a reserved session (auto-selects the session tab before calling). `tool` should be a browser_* tool like browser_navigate/browser_click/browser_snapshot.",
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
              name: TOOL_NAMES.playwrightPoolSessionEnd,
              description:
                "Release the reserved pool slot (optionally close the tab and/or forget durable sessionKey pinning).",
              inputSchema: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  closeTab: {
                    type: "boolean",
                    description: "If true, close the selected tab before releasing (default: true unless sessionKey used).",
                  },
                  forget: {
                    type: "boolean",
                    description: "If true, delete durable sessionKey mapping (default: false).",
                  },
                },
                required: ["sessionId"],
                additionalProperties: false,
              },
            },
            {
              name: TOOL_NAMES.playwrightPoolRelease,
              description:
                "Release a previously reserved Playwright pool slot. Only releases locks held by this process (or stale locks from dead pids/expired TTL).",
              inputSchema: {
                type: "object",
                properties: { upstreamId: { type: "string" } },
                additionalProperties: false,
              },
            },
          ]
        : []),
      ...PLAYWRIGHT_SESSION_TOOL_DEFS,
      ...(routes.toolDefs ?? []),
    ]),
    };
  } catch (e) {
    console.error("[Mx-gateway] ListTools failed:", e);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResponse> => {
  let name = "unknown";
  try {
    name = normalizeToolName(request.params.name);
    const args = request.params.arguments ?? {};

    const builtinAllowlist = allowlistFromEnv("MX_BUILTIN_ALLOWLIST");
    if (builtinAllowlist) {
      const isBuiltin = Object.values(TOOL_NAMES).includes(name as any);
      if (isBuiltin && !builtinAllowlist.has(name)) {
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: false,
                error: `Tool is disabled by MX_BUILTIN_ALLOWLIST: ${name}`,
              }),
            },
          ],
        };
      }
    }

    if (name === TOOL_NAMES.upstreamsList) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              upstreams,
              registry: registryUpstreams,
              registry_path: resolveRegistryPath(),
              registry_error: registryLoadError,
              session_allowlist: upstreamSessionAllowlist ? Array.from(upstreamSessionAllowlist.values()).sort() : null,
              env_allowlist: process.env.MX_UPSTREAM_ALLOWLIST ?? null,
              errors: Object.fromEntries(upstreamErrors.entries()),
            }),
          },
        ],
      };
    }

    if (name === TOOL_NAMES.upstreamsReload) {
      await loadRegistry();
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: !registryLoadError,
              error: registryLoadError,
              upstreams,
            }),
          },
        ],
      };
    }

    if (name === TOOL_NAMES.upstreamsSetEnabled) {
      const ids = normalizeArgArray((args as any)?.ids).map((id) => String(id).trim()).filter(Boolean);
      const enabled = Boolean((args as any)?.enabled);
      const dryRun = Boolean((args as any)?.dry_run);
      const shouldReload = (args as any)?.reload === undefined ? true : Boolean((args as any)?.reload);

      if (ids.length === 0) {
        return { content: [{ type: "text", text: asJsonText({ ok: false, error: "ids[] required" }) }] };
      }

      const reg = await readRegistry();
      const byId = new Map(reg.upstreams.map((u) => [u.id, u] as const));
      const changed: Array<{ id: string; before?: boolean; after?: boolean; ok: boolean; reason?: string }> = [];

      for (const id of ids) {
        const u = byId.get(id);
        if (!u) {
          changed.push({ id, ok: false, reason: "not found in registry" });
          continue;
        }
        const before = u.enabled !== false;
        const after = enabled;
        if (!dryRun) {
          u.enabled = after;
        }
        changed.push({ id, before, after, ok: true });
      }

      if (!dryRun) {
        await writeRegistry({ ...reg, upstreams: Array.from(byId.values()) });
        if (shouldReload) await loadRegistry();
      }

      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: changed.every((c) => c.ok),
              dry_run: dryRun,
              enabled,
              changed,
              upstreams: shouldReload && !dryRun ? upstreams : undefined,
            }),
          },
        ],
      };
    }

  if (name === TOOL_NAMES.upstreamsSetActive) {
    const modeRaw = typeof (args as any)?.mode === "string" ? String((args as any).mode) : "replace";
    const mode = (["replace", "merge", "clear"] as const).includes(modeRaw as any)
      ? (modeRaw as "replace" | "merge" | "clear")
      : null;
    if (!mode) {
      return {
        content: [{ type: "text", text: asJsonText({ ok: false, error: `invalid mode: ${modeRaw}` }) }],
      };
    }

    const shouldReload = (args as any)?.reload === undefined ? true : Boolean((args as any)?.reload);
    const dryRun = Boolean((args as any)?.dry_run);
    const before = upstreamSessionAllowlist ? Array.from(upstreamSessionAllowlist.values()).sort() : null;

    let next: Set<string> | null = upstreamSessionAllowlist ? new Set(upstreamSessionAllowlist) : null;

    if (mode === "clear") {
      next = null;
    } else if (mode === "replace") {
      const activeIds = normalizeArgArray((args as any)?.active_ids).map((id) => String(id).trim()).filter(Boolean);
      next = new Set(activeIds);
    } else if (mode === "merge") {
      const enableIds = normalizeArgArray((args as any)?.enable_ids).map((id) => String(id).trim()).filter(Boolean);
      const disableIds = normalizeArgArray((args as any)?.disable_ids).map((id) => String(id).trim()).filter(Boolean);
      // Start from current effective set if no allowlist is active yet.
      if (!next) next = new Set(upstreams.map((u) => u.id));
      for (const id of enableIds) next.add(id);
      for (const id of disableIds) next.delete(id);
    }

    if (!dryRun) {
      upstreamSessionAllowlist = next;
      if (shouldReload) await loadRegistry();
    }

    const after = next ? Array.from(next.values()).sort() : null;
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: true,
            dry_run: dryRun,
            mode,
            session_allowlist_before: before,
            session_allowlist_after: after,
            upstreams: shouldReload && !dryRun ? upstreams : undefined,
          }),
        },
      ],
    };
  }

  if (name === TOOL_NAMES.llmCodexExec || name === TOOL_NAMES.llmClaudeExec) {
    const cmdArgs = normalizeArgArray((args as any)?.args);
    const stdin = typeof (args as any)?.stdin === "string" ? String((args as any).stdin) : undefined;
    const program = name === TOOL_NAMES.llmCodexExec ? "codex" : "claude";
    const cmd = buildShellCommand(program, cmdArgs, stdin);
    const result = await runShellCommand(cmd);
    return { content: [{ type: "text", text: asJsonText(result) }] };
  }

  if (name === TOOL_NAMES.llmModelsRefresh) {
    const catalog = await refreshModelsCache();
    return { content: [{ type: "text", text: asJsonText(catalog) }] };
  }

  if (name === TOOL_NAMES.llmModelsList) {
    const refresh = (args as any)?.refresh === true;
    const ttlSecondsRaw = (args as any)?.ttlSeconds;
    const ttlSeconds =
      typeof ttlSecondsRaw === "number" && Number.isFinite(ttlSecondsRaw) ? Math.max(0, ttlSecondsRaw) : 3600;
    let cache = await readModelsCache();
    const stale =
      !cache ||
      (ttlSeconds > 0 &&
        cache.updated_at &&
        Date.now() - Date.parse(cache.updated_at) > ttlSeconds * 1000);
    if (refresh || stale) {
      cache = await refreshModelsCache();
    }
    return { content: [{ type: "text", text: asJsonText({ ...cache, stale }) }] };
  }

  if (name === TOOL_NAMES.interactionsCreate) {
    return handleInteractionsCreate(args as Record<string, unknown>);
  }

  if (name === TOOL_NAMES.manageStart) {
    const sourceRoot =
      typeof (args as any)?.source_dir === "string" && String((args as any).source_dir).trim().length > 0
        ? path.resolve(String((args as any).source_dir))
        : sourceDir();
    const repoDir =
      typeof (args as any)?.repo_dir === "string" && String((args as any).repo_dir).trim().length > 0
        ? path.resolve(String((args as any).repo_dir))
        : undefined;
    const cwdOverride =
      typeof (args as any)?.cwd === "string" && String((args as any).cwd).trim().length > 0
        ? String((args as any).cwd)
        : repoDir;
    const patchedArgs = { ...args, ...(cwdOverride ? { cwd: cwdOverride } : {}) } as Record<
      string,
      unknown
    >;
    const prefix = buildManagementSystemInstruction(sourceRoot, repoDir);
    return handleInteractionsCreate(patchedArgs, { systemInstructionPrefix: prefix, allowMissingModel: true });
  }

  if (name === TOOL_NAMES.interactionsGet) {
    const id = typeof (args as any)?.id === "string" ? String((args as any).id) : "";
    if (!id) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "id required" }) }] };
    }
    const record = readInteraction(id);
    if (!record) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "not found" }) }] };
    }
    return { content: [{ type: "text", text: asJsonText(record) }] };
  }

  if (name === TOOL_NAMES.interactionsEvents) {
    const cursorRaw = (args as any)?.cursor;
    const cursor = typeof cursorRaw === "number" && Number.isFinite(cursorRaw) ? Math.max(0, cursorRaw) : 0;
    const limitRaw = (args as any)?.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 50;
    const events = interactionEvents.filter((event) => event.id > cursor).slice(0, limit);
    const nextCursor = events.length > 0 ? events[events.length - 1].id : cursor;
    return { content: [{ type: "text", text: asJsonText({ events, next_cursor: nextCursor }) }] };
  }

  if (name === TOOL_NAMES.interactionsWait) {
    const cursorRaw = (args as any)?.cursor;
    const cursor = typeof cursorRaw === "number" && Number.isFinite(cursorRaw) ? Math.max(0, cursorRaw) : 0;
    const limitRaw = (args as any)?.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 1;
    const timeoutRaw = (args as any)?.timeout_ms;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.min(Math.max(timeoutRaw, 0), 300000)
        : 30000;
    const payload = await waitForInteractionEvent(cursor, limit, timeoutMs);
    return { content: [{ type: "text", text: asJsonText(payload) }] };
  }

  if (name === TOOL_NAMES.interactionsCancel) {
    const id = typeof (args as any)?.id === "string" ? String((args as any).id) : "";
    if (!id) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "id required" }) }] };
    }
    const state = getInteractionState(id);
    if (!state) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "not found" }) }] };
    }
    if (state.interaction.status === "in_progress" || state.interaction.status === "requires_action") {
      closeClaudeSession(state.sessionKey, "interaction cancelled");
      const cancelled = updateInteraction(id, (interaction) => ({
        ...interaction,
        status: "cancelled",
        updated: nowIso(),
      }));
      if (cancelled) pushInteractionEvent(cancelled);
      backgroundJobs.delete(id);
      return { content: [{ type: "text", text: asJsonText(cancelled ?? state.interaction) }] };
    }
    return { content: [{ type: "text", text: asJsonText(state.interaction) }] };
  }

  if (name === TOOL_NAMES.interactionsDelete) {
    const id = typeof (args as any)?.id === "string" ? String((args as any).id) : "";
    if (!id) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "id required" }) }] };
    }
    const ok = deleteInteractionState(id);
    return { content: [{ type: "text", text: asJsonText(ok ? {} : { ok: false, error: "not found" }) }] };
  }

  if (name === TOOL_NAMES.validateSkills) {
    const targetRaw = typeof (args as any)?.target === "string" ? String((args as any).target) : "both";
    const target = targetRaw === "codex" || targetRaw === "claude" ? targetRaw : "both";
    const format = typeof (args as any)?.format === "string" ? String((args as any).format) : "text";
    const skillDirs = Array.isArray((args as any)?.skill_dir)
      ? (args as any)?.skill_dir.filter((dir: unknown) => typeof dir === "string")
      : undefined;
    const report = await validateSkills({
      target,
      autofix: (args as any)?.autofix === true,
      backup: (args as any)?.backup === true,
      errorsOnly: (args as any)?.errors_only === true,
      skillDirs,
    });
    const text = format === "json" ? asJsonText(report) : formatValidationText(report);
    return { content: [{ type: "text", text }] };
  }

  if (name === TOOL_NAMES.analyzeSkills) {
    const targetRaw = typeof (args as any)?.target === "string" ? String((args as any).target) : "both";
    const target = targetRaw === "codex" || targetRaw === "claude" ? targetRaw : "both";
    const format = typeof (args as any)?.format === "string" ? String((args as any).format) : "text";
    const skillDirs = Array.isArray((args as any)?.skill_dir)
      ? (args as any)?.skill_dir.filter((dir: unknown) => typeof dir === "string")
      : undefined;
    const report = await analyzeSkills({ target, skillDirs });
    const text = format === "json" ? asJsonText(report) : formatAnalysisText(report);
    return { content: [{ type: "text", text }] };
  }

  if (name === TOOL_NAMES.sync) {
    const sourceRoot = typeof (args as any)?.source_dir === "string" ? String((args as any).source_dir) : undefined;
    const skillTargetRaw =
      typeof (args as any)?.skill_target === "string" ? String((args as any).skill_target) : "both";
    const skillTarget = skillTargetRaw === "codex" || skillTargetRaw === "claude" ? skillTargetRaw : "both";
    const commandTargetRaw =
      typeof (args as any)?.command_target === "string" ? String((args as any).command_target) : "both";
    const commandTarget = commandTargetRaw === "codex" || commandTargetRaw === "claude" ? commandTargetRaw : "both";
    const commandScopeRaw =
      typeof (args as any)?.command_scope === "string" ? String((args as any).command_scope) : "global";
    const commandScope =
      commandScopeRaw === "project" || commandScopeRaw === "both" ? commandScopeRaw : "global";
    const repoDir = typeof (args as any)?.repo_dir === "string" ? String((args as any).repo_dir) : undefined;
    const result = await syncFromSource({
      sourceDir: sourceRoot,
      syncRegistry: (args as any)?.sync_registry !== false,
      syncSkills: (args as any)?.sync_skills !== false,
      syncCommands: (args as any)?.sync_commands !== false,
      backup: (args as any)?.backup === true,
      dryRun: (args as any)?.dry_run === true,
      skillTarget,
      pruneSkills: (args as any)?.prune_skills === true,
      commandTarget,
      commandScope,
      repoDir,
      pruneCommands: (args as any)?.prune_commands === true,
    });
    return { content: [{ type: "text", text: asJsonText(result) }] };
  }

  if (name === TOOL_NAMES.playwrightPoolList) {
    const status = await listPoolStatus(heldPlaywrightLeases);
    return { content: [{ type: "text", text: asJsonText({ ok: true, pool: status, data: { pool: status } }) }] };
  }

  if (name === TOOL_NAMES.playwrightPoolStatus) {
    const status = await listPoolStatus(heldPlaywrightLeases);
    const reg = await readRegistry();
    const generator = (reg as any)?.playwright_pool ?? null;
    let expansion: any = null;
    if (generator && typeof generator === "object") {
      const templateUpstreamId =
        typeof generator.template_upstream_id === "string" && generator.template_upstream_id.trim().length > 0
          ? generator.template_upstream_id
          : "playwright";
      const idPrefix =
        typeof generator.id_prefix === "string" && generator.id_prefix.trim().length > 0 ? generator.id_prefix : "playwright";
      const count =
        typeof generator.count === "number" && Number.isFinite(generator.count) ? generator.count : 0;
      const plan = planPlaywrightPoolScale({
        registry: reg,
        templateUpstreamId,
        idPrefix,
        count,
        prune: false,
      });
      if ((plan as any)?.ok === false) {
        expansion = { ok: false, error: (plan as any).error };
      } else {
        const drift = {
          created: (plan as any).created,
          updated: (plan as any).updated,
          disabled: (plan as any).disabled,
          removed: (plan as any).removed,
          warnings: (plan as any).warnings,
        };
        const matches =
          drift.created.length === 0 &&
          drift.updated.length === 0 &&
          drift.disabled.length === 0 &&
          drift.removed.length === 0;
        expansion = {
          ok: true,
          matches,
          templateUpstreamId: (plan as any).templateUpstreamId,
          idPrefix: (plan as any).idPrefix,
          desiredCount: (plan as any).desiredCount,
          drift,
        };
      }
    }
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: true,
            data: {
              poolIds: configuredPoolIds(),
              env: { MX_PLAYWRIGHT_POOL: process.env.MX_PLAYWRIGHT_POOL ?? null },
              registry_path: resolveRegistryPath(),
              generator,
              expansion,
              pool: status,
            },
            pool: status,
            generator,
            expansion,
          }),
        },
      ],
    };
  }

  if (name === TOOL_NAMES.playwrightPoolScale) {
    const countRaw = (args as any)?.count;
    const count = typeof countRaw === "number" ? countRaw : Number(countRaw);
    if (!Number.isFinite(count)) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "count must be a number" }) }] };
    }

    const templateUpstreamId =
      typeof (args as any)?.templateUpstreamId === "string" && String((args as any).templateUpstreamId).trim().length > 0
        ? String((args as any).templateUpstreamId).trim()
        : "playwright";
    const idPrefix =
      typeof (args as any)?.idPrefix === "string" && String((args as any).idPrefix).trim().length > 0
        ? String((args as any).idPrefix).trim()
        : "playwright";
    const prune = Boolean((args as any)?.prune);
    const dryRun = Boolean((args as any)?.dry_run);
    const shouldReload = (args as any)?.reload === undefined ? true : Boolean((args as any)?.reload);

    const reg = await readRegistry();
    const plan = planPlaywrightPoolScale({ registry: reg, templateUpstreamId, idPrefix, count, prune });
    if ((plan as any)?.ok === false) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: (plan as any).error }) }] };
    }

    if (!dryRun) {
      await writeRegistry((plan as any).nextRegistry);
      if (shouldReload) await loadRegistry();
    }

    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: true,
            dry_run: dryRun,
            prune,
            templateUpstreamId: (plan as any).templateUpstreamId,
            idPrefix: (plan as any).idPrefix,
            desiredCount: (plan as any).desiredCount,
            created: (plan as any).created,
            updated: (plan as any).updated,
            disabled: (plan as any).disabled,
            removed: (plan as any).removed,
            warnings: (plan as any).warnings,
            registry_path: resolveRegistryPath(),
            upstreams: shouldReload && !dryRun ? upstreams : undefined,
          }),
        },
      ],
    };
  }

  if (name === TOOL_NAMES.playwrightPoolReserve) {
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
              error: "Playwright pool not configured. Set MX_PLAYWRIGHT_POOL=playwright1,playwright2",
            }),
          },
        ],
      };
    }

    const attempts: Array<{ upstreamId: string; ok: boolean; reason?: string; reused?: boolean }> = [];
    for (const upstreamId of pool) {
      if (heldPlaywrightLeases.has(upstreamId)) {
        attempts.push({ upstreamId, ok: false, reason: "Already held by this process." });
        continue;
      }
      const acquired = await tryAcquireLock(upstreamId, ttl);
      if (acquired.ok) {
        heldPlaywrightLeases.add(upstreamId);
        heldPlaywrightLeaseTtls.set(upstreamId, ttl);
        const prefix = `${encodeToolNamePart(upstreamId)}__`;
        return {
          content: [
            {
              type: "text",
              text: asJsonText({
                ok: true,
                upstreamId,
                ttlSeconds: ttl,
                reused: Boolean((acquired as any)?.reused),
                toolPrefix: prefix,
                usage: `Call tools using the prefix: ${prefix}<tool> (e.g. ${prefix}browser_navigate).`,
              }),
            },
          ],
        };
      }
      attempts.push({ upstreamId, ok: false, reason: acquired.reason });
    }

    const status = await listPoolStatus(heldPlaywrightLeases);
    return {
      content: [
        {
          type: "text",
          text: asJsonText({
            ok: false,
            error: "No free pool slots.",
            attempts,
            pool: status,
          }),
        },
      ],
    };
  }

  if (name === TOOL_NAMES.playwrightPoolSessionStart) {
    const ttlSeconds = Number((args as any)?.ttlSeconds ?? 900);
    const ttl = Number.isFinite(ttlSeconds) ? Math.min(Math.max(ttlSeconds, 30), 3600) : 900;
    const sessionKeyRaw = typeof (args as any)?.sessionKey === "string" ? String((args as any).sessionKey) : "";
    const sessionKey = sessionKeyRaw.trim().length > 0 ? sessionKeyRaw.trim() : null;
    const newTab =
      typeof (args as any)?.newTab === "boolean" ? Boolean((args as any).newTab) : true;

    const parseTabs = (tabsText: string): Array<{ index: number; detail: string }> => {
      const re = /^-\s*(\d+):\s*(.*)$/gm;
      const tabs: Array<{ index: number; detail: string }> = [];
      for (;;) {
        const m = re.exec(tabsText);
        if (!m) break;
        const idx = Number(m[1]);
        if (!Number.isFinite(idx)) continue;
        tabs.push({ index: idx, detail: String(m[2] ?? "").trim() });
      }
      return tabs;
    };

    const readTabFingerprint = async (upstreamId: string, tabIndex: number): Promise<string | undefined> => {
      try {
        const tabs = await callUpstreamTool({
          upstreamId,
          tool: "browser_tabs",
          arguments: { action: "list" },
          label: `${upstreamId}.browser_tabs.list`,
          timeoutMs: Number(process.env.MX_UPSTREAM_CALL_TIMEOUT_MS ?? 20000),
        });
        const tabsText = String((tabs as any)?.content?.[0]?.text ?? "");
        const parsed = parseTabs(tabsText);
        return parsed.find((t) => t.index === tabIndex)?.detail || undefined;
      } catch {
        return undefined;
      }
    };

    if (sessionKey) {
      const existingId = playwrightSessionKeys.get(sessionKey);
      if (existingId) {
        const existing = playwrightSessions.get(existingId);
        if (existing) {
          const acquired = await tryAcquireLock(existing.upstreamId, ttl);
          if (acquired.ok) {
            heldPlaywrightLeases.add(existing.upstreamId);
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: asJsonText({
                    ok: false,
                    error: `Failed to reacquire locked slot for sessionKey '${sessionKey}': ${acquired.reason}`,
                    upstreamId: existing.upstreamId,
                  }),
                },
              ],
            };
          }
        }
        if (existing && heldPlaywrightLeases.has(existing.upstreamId)) {
          await savePoolSessionMapping(sessionKey, {
            upstreamId: existing.upstreamId,
            tabIndexHint: existing.tabIndex,
            tabFingerprint: await readTabFingerprint(existing.upstreamId, existing.tabIndex),
          });
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
                    `Use ${TOOL_NAMES.playwrightPoolSessionCall} with tool=browser_navigate/browser_click/... then ${TOOL_NAMES.playwrightPoolSessionEnd}.`,
                }),
              },
            ],
          };
        }
        playwrightSessionKeys.delete(sessionKey);
      }

      const persisted = await loadPoolSessionMapping();
      const pinned = persisted[sessionKey];
      if (pinned?.upstreamId) {
        const acquired = await tryAcquireLock(pinned.upstreamId, ttl);
        if (!acquired.ok) {
          return {
            content: [
              {
                type: "text",
                text: asJsonText({
                  ok: false,
                  error: `SessionKey '${sessionKey}' is pinned to upstream '${pinned.upstreamId}' but it is unavailable: ${acquired.reason}`,
                  sessionKey,
                  upstreamId: pinned.upstreamId,
                }),
              },
            ],
          };
        }

      heldPlaywrightLeases.add(pinned.upstreamId);
      heldPlaywrightLeaseTtls.set(pinned.upstreamId, ttl);
      try {
          const tabs = await callUpstreamTool({
            upstreamId: pinned.upstreamId,
            tool: "browser_tabs",
            arguments: { action: "list" },
            label: `${pinned.upstreamId}.browser_tabs.list`,
          });
          const tabsText = String((tabs as any)?.content?.[0]?.text ?? "");
          const parsed = parseTabs(tabsText);

          let tabIndex: number | null = null;
          if (typeof pinned.tabFingerprint === "string" && pinned.tabFingerprint.trim().length > 0) {
            const matches = parsed.filter((t) => t.detail === pinned.tabFingerprint);
            if (matches.length > 0) {
              const preferred =
                typeof pinned.tabIndexHint === "number"
                  ? matches.find((t) => t.index === pinned.tabIndexHint)
                  : null;
              tabIndex = (preferred ?? matches[0])?.index ?? null;
            }
          }
          if (tabIndex === null && typeof pinned.tabIndexHint === "number") {
            if (parsed.some((t) => t.index === pinned.tabIndexHint)) tabIndex = pinned.tabIndexHint;
          }

          let createdNewTab = false;
          if (tabIndex === null) {
            await callUpstreamTool({
              upstreamId: pinned.upstreamId,
              tool: "browser_tabs",
              arguments: { action: "new" },
              label: `${pinned.upstreamId}.browser_tabs.new`,
            });
            const tabs2 = await callUpstreamTool({
              upstreamId: pinned.upstreamId,
              tool: "browser_tabs",
              arguments: { action: "list" },
              label: `${pinned.upstreamId}.browser_tabs.list`,
            });
            const tabsText2 = String((tabs2 as any)?.content?.[0]?.text ?? "");
            const parsed2 = parseTabs(tabsText2);
            tabIndex = parsed2.length > 0 ? Math.max(...parsed2.map((t) => t.index)) : 0;
            createdNewTab = true;
          }

          await callUpstreamTool({
            upstreamId: pinned.upstreamId,
            tool: "browser_tabs",
            arguments: { action: "select", index: tabIndex },
            label: `${pinned.upstreamId}.browser_tabs.select`,
          });
          const fingerprint = (await readTabFingerprint(pinned.upstreamId, tabIndex)) ?? pinned.tabFingerprint;
          const sessionId = randomUUID();
          playwrightSessions.set(sessionId, { upstreamId: pinned.upstreamId, tabIndex, sessionKey });
          playwrightSessionKeys.set(sessionKey, sessionId);
          await savePoolSessionMapping(sessionKey, { upstreamId: pinned.upstreamId, tabIndexHint: tabIndex, tabFingerprint: fingerprint });

          return {
            content: [
              {
                type: "text",
                text: asJsonText({
                  ok: true,
                  sessionId,
                  upstreamId: pinned.upstreamId,
                  tabIndex,
                  newTab: createdNewTab,
                  reused: true,
                  usage:
                    `Use ${TOOL_NAMES.playwrightPoolSessionCall} with tool=browser_navigate/browser_click/... then ${TOOL_NAMES.playwrightPoolSessionEnd}.`,
                }),
              },
            ],
          };
        } catch (e) {
          heldPlaywrightLeases.delete(pinned.upstreamId);
          await releaseLock(pinned.upstreamId);
          return { content: [{ type: "text", text: asJsonText({ ok: false, error: String(e) }) }] };
        }
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
                "Playwright pool not configured. Set MX_PLAYWRIGHT_POOL=playwright1,playwright2",
            }),
          },
        ],
      };
    }

    const attempts: Array<{ upstreamId: string; ok: boolean; reason?: string }> = [];
    for (const upstreamId of pool) {
      if (heldPlaywrightLeases.has(upstreamId)) {
        attempts.push({ upstreamId, ok: false, reason: "Already held by this process." });
        continue;
      }
      const acquired = await tryAcquireLock(upstreamId, ttl);
      if (!acquired.ok) {
        attempts.push({ upstreamId, ok: false, reason: acquired.reason });
        continue;
      }

      heldPlaywrightLeases.add(upstreamId);
      heldPlaywrightLeaseTtls.set(upstreamId, ttl);
      try {
        if (newTab) {
          await callUpstreamTool({
            upstreamId,
            tool: "browser_tabs",
            arguments: { action: "new" },
            label: `${upstreamId}.browser_tabs.new`,
          });
        }
        const listTabs = async () => {
          const tabs = await callUpstreamTool({
            upstreamId,
            tool: "browser_tabs",
            arguments: { action: "list" },
            label: `${upstreamId}.browser_tabs.list`,
          });
          const tabsText = String((tabs as any)?.content?.[0]?.text ?? "");
          const parsed = parseTabs(tabsText);
          if (parsed.length === 0) return -1;
          return Math.max(...parsed.map((t) => t.index));
        };
        let tabIndex = await listTabs();
        if (tabIndex < 0) {
          await callUpstreamTool({
            upstreamId,
            tool: "browser_tabs",
            arguments: { action: "new" },
            label: `${upstreamId}.browser_tabs.new`,
          });
          tabIndex = await listTabs();
        }
        if (tabIndex < 0) tabIndex = 0;
        await callUpstreamTool({
          upstreamId,
          tool: "browser_tabs",
          arguments: { action: "select", index: tabIndex },
          label: `${upstreamId}.browser_tabs.select`,
        });

        const sessionId = randomUUID();
        playwrightSessions.set(sessionId, { upstreamId, tabIndex, sessionKey: sessionKey ?? undefined });
        if (sessionKey) {
          playwrightSessionKeys.set(sessionKey, sessionId);
          await savePoolSessionMapping(sessionKey, {
            upstreamId,
            tabIndexHint: tabIndex,
            tabFingerprint: await readTabFingerprint(upstreamId, tabIndex),
          });
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
                  `Use ${TOOL_NAMES.playwrightPoolSessionCall} with tool=browser_navigate/browser_click/... then ${TOOL_NAMES.playwrightPoolSessionEnd}.`,
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

    const status = await listPoolStatus(heldPlaywrightLeases);
    return {
      content: [
        {
          type: "text",
          text: asJsonText({ ok: false, error: "No free pool slots.", attempts, pool: status }),
        },
      ],
    };
  }

  if (name === TOOL_NAMES.playwrightPoolSessionCall) {
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

    // Always re-select the session tab before each call.
    await callUpstreamTool({
      upstreamId: session.upstreamId,
      tool: "browser_tabs",
      arguments: { action: "select", index: session.tabIndex },
      label: `${session.upstreamId}.browser_tabs.select`,
    });
    const res = await callUpstreamTool({
      upstreamId: session.upstreamId,
      tool,
      arguments: toolArgs,
      label: `${session.upstreamId}.${tool}`,
    });
    const content = (res as any)?.content;
    return { content: Array.isArray(content) ? content : [{ type: "text", text: "" }] };
  }

  if (name === TOOL_NAMES.playwrightPoolSessionEnd) {
    const sessionId = String((args as any)?.sessionId ?? "");
    if (!sessionId) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "sessionId required" }) }] };
    }
    const session = playwrightSessions.get(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "Unknown sessionId" }) }] };
    }
    const closeTabArg = (args as any)?.closeTab;
    const forgetArg = (args as any)?.forget;
    const closeTab =
      typeof closeTabArg === "boolean" ? closeTabArg : session.sessionKey ? false : true;
    const forget = typeof forgetArg === "boolean" ? forgetArg : false;
    if (session.sessionKey) {
      const mapped = playwrightSessionKeys.get(session.sessionKey);
      if (mapped === sessionId) {
        playwrightSessionKeys.delete(session.sessionKey);
      }
    }
    const upstreamId = session.upstreamId;
    const held = heldPlaywrightLeases.has(upstreamId);
    try {
      if (held && closeTab) {
        await callUpstreamTool({
          upstreamId,
          tool: "browser_tabs",
          arguments: { action: "close", index: session.tabIndex },
          label: `${upstreamId}.browser_tabs.close`,
        });
      }
    } catch {
      // ignore cleanup errors
    }
    playwrightSessions.delete(sessionId);
    if (held) {
      await releaseLock(upstreamId);
      heldPlaywrightLeases.delete(upstreamId);
      heldPlaywrightLeaseTtls.delete(upstreamId);
    }
    if (session.sessionKey && forget) {
      await deletePoolSessionMapping(session.sessionKey);
    }
    return { content: [{ type: "text", text: asJsonText({ ok: true }) }] };
  }

  if (name === TOOL_NAMES.playwrightPoolRelease) {
    const upstreamId = String((args as any)?.upstreamId ?? "");
    if (!upstreamId) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: "upstreamId required" }) }] };
    }
    const result = await releaseLock(upstreamId);
    heldPlaywrightLeases.delete(upstreamId);
    heldPlaywrightLeaseTtls.delete(upstreamId);
    if (!result.ok) {
      return { content: [{ type: "text", text: asJsonText({ ok: false, error: result.reason }) }] };
    }
    return { content: [{ type: "text", text: asJsonText({ ok: true, released: result.released }) }] };
  }

  if (isPlaywrightSessionTool(name)) {
    const result = await handlePlaywrightSessionTool(name, args as Record<string, unknown>);
    if (result) return result;
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
              error: `Playwright slot '${upstreamId}' requires reservation. Call ${TOOL_NAMES.playwrightPoolReserve} first.`,
            }),
          },
        ],
      };
    }
    try {
      const res = await callUpstreamTool({
        upstreamId,
        tool: upstreamTool,
        arguments: args as any,
        label: `${upstreamId}.${upstreamTool}`,
      });
      const content = (res as any)?.content;
      return { content: Array.isArray(content) ? content : [{ type: "text", text: "" }] };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: asJsonText({
              ok: false,
              error: `Upstream tool call failed: ${upstreamId}.${upstreamTool}`,
              details: String(e),
              upstreamId,
              tool: upstreamTool,
            }),
          },
        ],
      };
    }
  }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (e) {
    console.error(`[Mx-gateway] Tool handler failed (${name}):`, e);
    return {
      content: [
        {
          type: "text",
          text: asJsonText({ ok: false, error: String(e) }),
        },
      ],
    };
  }
});

await loadRegistry();

const transport = new StdioServerTransport();
await server.connect(transport);
