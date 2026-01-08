import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export type SkillManifestTarget = "codex" | "claude";

const targetDefaultsSchema = z
  .object({
    codex: z.boolean().optional(),
    claude: z.boolean().optional(),
  })
  .strict();

const enablementSchema = z.union([
  z.boolean(),
  z
    .object({
      codex: z.boolean().optional(),
      claude: z.boolean().optional(),
    })
    .strict(),
]);

const manifestSchema = z
  .object({
    version: z.literal(1),
    defaults: targetDefaultsSchema.optional(),
    skills: z.record(enablementSchema).optional().default({}),
  })
  .strict();

export type SkillsManifest = z.infer<typeof manifestSchema>;

export function skillsManifestPath(skillsRoot: string): string {
  return path.join(skillsRoot, "manifest.json");
}

export function defaultSkillsManifest(): SkillsManifest {
  return { version: 1, defaults: { codex: true, claude: true }, skills: {} };
}

type ReadSkillsManifestResult =
  | { ok: true; path: string; exists: false; manifest: null }
  | { ok: true; path: string; exists: true; manifest: SkillsManifest }
  | { ok: false; path: string; exists: true; error: string };

export async function readSkillsManifest(skillsRoot: string): Promise<ReadSkillsManifestResult> {
  const filePath = skillsManifestPath(skillsRoot);
  if (!existsSync(filePath)) return { ok: true, path: filePath, exists: false, manifest: null };
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const manifest = manifestSchema.parse(raw);
    return { ok: true, path: filePath, exists: true, manifest };
  } catch (e) {
    return { ok: false, path: filePath, exists: true, error: String(e) };
  }
}

export async function writeSkillsManifest(skillsRoot: string, manifest: SkillsManifest): Promise<void> {
  const filePath = skillsManifestPath(skillsRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = manifestSchema.parse(manifest);
  const skillsSorted = Object.fromEntries(
    Object.entries(normalized.skills ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  await fs.writeFile(
    filePath,
    JSON.stringify({ ...normalized, skills: skillsSorted }, null, 2) + "\n",
    "utf8",
  );
}

export function isSkillEnabled(manifest: SkillsManifest | null, skillId: string, target: SkillManifestTarget): boolean {
  const defaultEnabled = manifest?.defaults?.[target] ?? true;
  const entry = manifest?.skills?.[skillId];
  if (entry === undefined) return defaultEnabled;
  if (typeof entry === "boolean") return entry;
  const perTarget = entry?.[target];
  return typeof perTarget === "boolean" ? perTarget : defaultEnabled;
}
