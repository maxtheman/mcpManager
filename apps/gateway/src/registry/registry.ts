import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const upstreamSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  env_vars: z.array(z.string()).default([]),
});

export type Upstream = z.infer<typeof upstreamSchema>;

const registrySchema = z.object({
  version: z.literal(1),
  upstreams: z.array(upstreamSchema).default([]),
});

export type Registry = z.infer<typeof registrySchema>;

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export function defaultRegistryPath(): string {
  return path.join(homeDir(), ".mcpmanager", "registry.json");
}

export function registryPath(): string {
  return process.env.MCPMANAGER_REGISTRY_PATH ?? defaultRegistryPath();
}

export async function readRegistry(): Promise<Registry> {
  const p = registryPath();
  if (!existsSync(p)) return { version: 1, upstreams: [] };
  const raw = JSON.parse(await fs.readFile(p, "utf8"));
  return registrySchema.parse(raw);
}

export async function writeRegistry(reg: Registry) {
  const p = registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(registrySchema.parse(reg), null, 2) + "\n", "utf8");
}

