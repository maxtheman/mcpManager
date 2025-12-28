import { z } from "zod";

export const BoundaryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  includeGlobs: z.array(z.string()),
  excludeGlobs: z.array(z.string()).optional(),
});

export const BoundaryRuleSchema = z.object({
  fromGroup: z.string(),
  toGroup: z.string(),
  allow: z.boolean(),
  maxHops: z.number().optional(),
  onlyViaPublicApi: z.boolean().optional(),
});

export const BoundariesConfigSchema = z.object({
  groups: z.array(BoundaryGroupSchema),
  rules: z.array(BoundaryRuleSchema),
});

export const AdoConfigSchema = z.object({
  repoName: z.string(),
  repoRoot: z.string(),
  tsconfigPath: z.string().default("tsconfig.json"),
  
  helix: z.object({
    endpoint: z.string().default("http://localhost:6969"),
  }).default({}),
  
  agentfs: z.object({
    rootDir: z.string().default(".agentfs"),
  }).default({}),
  
  penpot: z.object({
    baseUrl: z.string().optional(),
    token: z.string().optional(),
  }).optional(),
  
  boundaries: BoundariesConfigSchema.optional(),
  
  includeGlobs: z.array(z.string()).default(["**/*.ts", "**/*.tsx"]),
  excludeGlobs: z.array(z.string()).default(["**/node_modules/**", "**/dist/**", "**/*.d.ts"]),
});

export type AdoConfig = z.infer<typeof AdoConfigSchema>;
export type BoundariesConfig = z.infer<typeof BoundariesConfigSchema>;
export type BoundaryGroup = z.infer<typeof BoundaryGroupSchema>;
export type BoundaryRule = z.infer<typeof BoundaryRuleSchema>;

export function loadConfig(configPath: string): AdoConfig {
  const fs = require("fs");
  const path = require("path");
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return AdoConfigSchema.parse(raw);
}

export function getDefaultConfig(repoRoot: string, repoName?: string): AdoConfig {
  const path = require("path");
  return AdoConfigSchema.parse({
    repoName: repoName ?? path.basename(repoRoot),
    repoRoot,
    tsconfigPath: "tsconfig.json",
  });
}
