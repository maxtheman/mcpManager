import type { AdoSession } from "./session.js";

export interface InteractionContent {
  role: "user" | "model" | "system";
  parts: Array<{ text: string } | { functionCall: FunctionCall } | { functionResponse: FunctionResponse }>;
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

export interface Interaction {
  id: string;
  model: string;
  createdAt: string;
  input: InteractionContent[];
  output: InteractionContent[];
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface InteractionIndex {
  interactions: string[];
  lastUpdated: string;
}

export async function recordInteraction(
  session: AdoSession,
  interaction: Omit<Interaction, "id" | "createdAt">
): Promise<string> {
  const id = `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  
  const fullInteraction: Interaction = {
    id,
    createdAt,
    ...interaction,
  };
  
  const path = `/conversations/${session.id}/${id}.json`;
  await session.agent.fs.writeFile(path, JSON.stringify(fullInteraction, null, 2));
  
  const indexPath = `/conversations/${session.id}/index.json`;
  let index: InteractionIndex;
  
  try {
    const existing = await session.agent.fs.readFile(indexPath, "utf-8");
    index = JSON.parse(existing as string);
  } catch {
    index = { interactions: [], lastUpdated: createdAt };
  }
  
  index.interactions.push(id);
  index.lastUpdated = createdAt;
  await session.agent.fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  
  await session.agent.tools.record(
    "record_interaction",
    Date.now() / 1000,
    Date.now() / 1000 + 0.001,
    { model: interaction.model, inputLength: interaction.input.length },
    { interactionId: id }
  );
  
  return id;
}

export async function getInteraction(
  session: AdoSession,
  interactionId: string
): Promise<Interaction | null> {
  const path = `/conversations/${session.id}/${interactionId}.json`;
  try {
    const content = await session.agent.fs.readFile(path, "utf-8");
    return JSON.parse(content as string) as Interaction;
  } catch {
    return null;
  }
}

export async function listInteractions(session: AdoSession): Promise<string[]> {
  const indexPath = `/conversations/${session.id}/index.json`;
  try {
    const content = await session.agent.fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(content as string) as InteractionIndex;
    return index.interactions;
  } catch {
    return [];
  }
}

export function createTextContent(role: InteractionContent["role"], text: string): InteractionContent {
  return {
    role,
    parts: [{ text }],
  };
}

export function createFunctionCallContent(name: string, args: Record<string, unknown>): InteractionContent {
  return {
    role: "model",
    parts: [{ functionCall: { name, args } }],
  };
}

export function createFunctionResponseContent(name: string, response: Record<string, unknown>): InteractionContent {
  return {
    role: "user",
    parts: [{ functionResponse: { name, response } }],
  };
}
