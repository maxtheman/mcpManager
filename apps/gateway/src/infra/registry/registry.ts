import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

const playwrightPoolSchema = z
  .object({
    template_upstream_id: z.string().min(1).default("playwright"),
    id_prefix: z.string().min(1).default("playwright"),
    count: z.number().int().min(0).default(0),
    // Optional per-slot env overrides (supports {id} substitution).
    per_slot_env: z.record(z.string()).default({}),
  })
  .default({
    template_upstream_id: "playwright",
    id_prefix: "playwright",
    count: 0,
    per_slot_env: {},
  });

const registrySchema = z.object({
  version: z.literal(1),
  upstreams: z.array(upstreamSchema).default([]),
  playwright_pool: playwrightPoolSchema.optional(),
}).passthrough();

export type Registry = z.infer<typeof registrySchema>;

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function defaultRegistryPath(): string {
  return path.join(homeDir(), ".Mx", "registry.json");
}

export function registryPath(): string {
  return process.env.MX_REGISTRY_PATH ?? defaultRegistryPath();
}

export async function readRegistryFile(filePath: string): Promise<Registry> {
  if (!existsSync(filePath)) return { version: 1, upstreams: [] };
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  return registrySchema.parse(raw);
}

export async function writeRegistryFile(filePath: string, reg: Registry) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(registrySchema.parse(reg), null, 2) + "\n", "utf8");
}

export async function readRegistry(): Promise<Registry> {
  return readRegistryFile(registryPath());
}

export async function writeRegistry(reg: Registry) {
  await writeRegistryFile(registryPath(), reg);
}
