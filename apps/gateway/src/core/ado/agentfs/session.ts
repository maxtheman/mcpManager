import { AgentFS } from "agentfs-sdk";

export interface SessionMetadata {
  sessionId: string;
  repoName: string;
  startedAt: string;
  status: "active" | "completed" | "failed";
}

export interface AdoSession {
  id: string;
  agent: typeof AgentFS.prototype;
  metadata: SessionMetadata;
}

let currentSession: AdoSession | null = null;

function makeAgentId(repoName: string, sessionId: string): string {
  return `ado_${repoName}_${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function openSession(params: {
  sessionId: string;
  repoName: string;
}): Promise<AdoSession> {
  const agentId = makeAgentId(params.repoName, params.sessionId);
  const agent = await AgentFS.open({ id: agentId });
  
  const metadata: SessionMetadata = {
    sessionId: params.sessionId,
    repoName: params.repoName,
    startedAt: new Date().toISOString(),
    status: "active",
  };
  
  await agent.kv.set("session:id", params.sessionId);
  await agent.kv.set("session:repo", params.repoName);
  await agent.kv.set("session:started_at", metadata.startedAt);
  await agent.kv.set("session:status", metadata.status);
  
  await ensureDirectories(agent);
  
  const session: AdoSession = {
    id: params.sessionId,
    agent,
    metadata,
  };
  
  currentSession = session;
  return session;
}

async function ensureDirectories(agent: typeof AgentFS.prototype): Promise<void> {
  const dirs = [
    "/artifacts",
    "/conversations",
    "/proposals",
    "/design",
    "/logs",
    "/snapshots",
    "/validations",
  ];
  
  for (const dir of dirs) {
    try {
      await agent.fs.readdir(dir);
    } catch {
      await agent.fs.writeFile(`${dir}/.keep`, "");
    }
  }
}

export async function getSession(sessionId: string, repoName: string): Promise<AdoSession | null> {
  try {
    const agentId = makeAgentId(repoName, sessionId);
    const agent = await AgentFS.open({ id: agentId });
    
    const status = await agent.kv.get<string>("session:status");
    if (!status) return null;
    
    const metadata: SessionMetadata = {
      sessionId,
      repoName,
      startedAt: await agent.kv.get<string>("session:started_at") ?? "",
      status: status as SessionMetadata["status"],
    };
    
    return { id: sessionId, agent, metadata };
  } catch {
    return null;
  }
}

export async function ensureSession(params: {
  sessionId: string;
  repoName: string;
}): Promise<AdoSession> {
  const existing = await getSession(params.sessionId, params.repoName);
  if (existing) {
    currentSession = existing;
    return existing;
  }

  return openSession(params);
}

export function getCurrentSession(): AdoSession | null {
  return currentSession;
}

export async function closeSession(session: AdoSession): Promise<void> {
  await session.agent.kv.set("session:status", "completed");
  await session.agent.kv.set("session:ended_at", new Date().toISOString());
  
  if (currentSession?.id === session.id) {
    currentSession = null;
  }
}

export async function recordToolCall(
  session: AdoSession,
  name: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  error?: string
): Promise<number> {
  const startedAt = Date.now() / 1000;
  const completedAt = startedAt + 0.001;
  
  return session.agent.tools.record(
    name,
    startedAt,
    completedAt,
    params,
    result,
    error
  );
}

export async function saveArtifact(
  session: AdoSession,
  artifactType: string,
  artifactId: string,
  content: unknown
): Promise<string> {
  const path = `/artifacts/${artifactType}/${artifactId}.json`;
  await session.agent.fs.writeFile(path, JSON.stringify(content, null, 2));
  
  const index = await session.agent.kv.get<string[]>(`artifacts:${artifactType}:index`) ?? [];
  if (!index.includes(artifactId)) {
    index.push(artifactId);
    await session.agent.kv.set(`artifacts:${artifactType}:index`, index);
  }
  
  return path;
}

export async function loadArtifact<T>(
  session: AdoSession,
  artifactType: string,
  artifactId: string
): Promise<T | null> {
  const path = `/artifacts/${artifactType}/${artifactId}.json`;
  try {
    const content = await session.agent.fs.readFile(path, "utf-8");
    return JSON.parse(content as string) as T;
  } catch {
    return null;
  }
}
