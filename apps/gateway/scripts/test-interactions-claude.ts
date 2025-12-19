import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = any;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function buildGateway(gatewayExe: string) {
  if (process.env.MCPMANAGER_SKIP_BUILD === "1" && existsSync(gatewayExe)) return;
  const proc = Bun.spawn(["bun", "run", "build:exe"], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) die("Failed to build gateway (bun run build:exe).");
  if (!existsSync(gatewayExe)) die(`Gateway binary missing at ${gatewayExe}`);
}

function parseJsonText(contentText: string): Json {
  try {
    return JSON.parse(contentText);
  } catch {
    return { raw: contentText };
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as any });
  const first = (res as any)?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) };
}

async function main() {
  const gatewayExe = path.join(import.meta.dir, "..", "dist", "mcpmanager-gateway");
  await buildGateway(gatewayExe);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpmanager-interactions-"));
  const registryPath = path.join(tmp, "registry.json");
  const interactionsDir = path.join(tmp, "interactions");
  await fs.writeFile(registryPath, JSON.stringify({ version: 1, upstreams: [] }, null, 2) + "\n", "utf8");

  const env = {
    MCPMANAGER_REGISTRY_PATH: registryPath,
    MCPMANAGER_INTERACTIONS_DIR: interactionsDir,
  };

  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "interactions-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const createdIds: string[] = [];

  const first = await callText(client, "interactions.create", {
    input: "Hello from MCP. Remember this message.",
  });
  if (!first.json?.id || !Array.isArray(first.json?.outputs)) {
    await client.close();
    die(`interactions.create failed: ${first.text}`);
  }
  const firstId = String(first.json.id);
  createdIds.push(firstId);
  const firstSession = String(first.json.session_id ?? "");

  const second = await callText(client, "interactions.create", {
    input: "What should you remember?",
    previous_interaction_id: firstId,
  });
  if (!second.json?.id || !Array.isArray(second.json?.outputs)) {
    await client.close();
    die(`interactions.create (follow-up) failed: ${second.text}`);
  }
  const secondSession = String(second.json.session_id ?? "");
  if (firstSession && secondSession && firstSession !== secondSession) {
    await client.close();
    die(`Expected same session_id, got ${firstSession} then ${secondSession}`);
  }

  const toolCall = await callText(client, "interactions.create", {
    input: "Use the echo tool to repeat 'hello'.",
    tools: [
      {
        type: "function",
        name: "echo",
        description: "Echo back the input message.",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "required",
  });
  if (!toolCall.json?.id || !Array.isArray(toolCall.json?.outputs)) {
    await client.close();
    die(`interactions.create (tool call) failed: ${toolCall.text}`);
  }
  const toolId = String(toolCall.json.id);
  createdIds.push(toolId);
  const toolOutput = toolCall.json.outputs.find((o: any) => o?.type === "function_call");
  if (!toolOutput || toolOutput.name !== "echo") {
    await client.close();
    die(`Expected function_call echo output, got: ${toolCall.text}`);
  }

  const background = await callText(client, "interactions.create", {
    input: "Reply with a short greeting.",
    background: true,
    timeout_ms: 8000,
  });
  if (!background.json?.id) {
    await client.close();
    die(`interactions.create (background) failed: ${background.text}`);
  }
  const backgroundId = String(background.json.id);
  createdIds.push(backgroundId);
  if (background.json.status !== "in_progress") {
    await client.close();
    die(`Expected background status in_progress, got: ${background.text}`);
  }
  let backgroundRecord: any = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(1000);
    const poll = await callText(client, "interactions.get", { id: backgroundId });
    if (!poll.json?.status || poll.json.status === "in_progress") {
      continue;
    }
    backgroundRecord = poll.json;
    break;
  }
  if (!backgroundRecord) {
    await client.close();
    die("Background interaction did not complete in time.");
  }

  const fetched = await callText(client, "interactions.get", { id: firstId });
  if (!fetched.json?.id) {
    await client.close();
    die(`interactions.get failed: ${fetched.text}`);
  }

  if (process.env.MCPMANAGER_IMAGE_TEST === "1") {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9nKxQAAAAASUVORK5CYII=";
    const imageRes = await callText(client, "interactions.create", {
      input: [
        { type: "text", text: "Describe this image briefly." },
        { type: "image", data: base64, mime_type: "image/png" },
      ],
    });
    if (!imageRes.json?.id || imageRes.json?.status === "failed") {
      await client.close();
      die(`interactions.create (image) failed: ${imageRes.text}`);
    }
    createdIds.push(String(imageRes.json.id));
  }

  for (const id of createdIds) {
    const deleted = await callText(client, "interactions.delete", { id });
    if (!deleted.json?.ok) {
      await client.close();
      die(`interactions.delete failed for ${id}: ${deleted.text}`);
    }
  }

  await client.close();
  console.log("OK");
  console.log(`- first id: ${firstId}`);
  console.log(`- session: ${firstSession || "(none)"}`);
}

await main();
