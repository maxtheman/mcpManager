import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function auditLogPath(): string {
  return path.join(homeDir(), ".mcpmanager", "audit.log");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/key|token|secret|password/i.test(k)) out[k] = "*****";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export async function audit(toolName: string, args: unknown, decision: PolicyDecision) {
  const line = JSON.stringify(
    {
      ts: new Date().toISOString(),
      tool: toolName,
      args: redact(args),
      decision,
    },
    null,
    0,
  );
  const p = auditLogPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, line + "\n", "utf8");
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

export function checkPolicy(toolName: string, args: any): PolicyDecision {
  const mode = (process.env.MCPMANAGER_POLICY_MODE ?? "strict").toLowerCase();
  if (mode === "permissive") return { ok: true };

  // Safe-by-default: block generating Tailscale auth keys unless explicitly enabled.
  if (toolName === "tailscale.keys.createEphemeral") {
    if (!truthy(process.env.MCPMANAGER_TAILSCALE_ALLOW_KEYS)) {
      return {
        ok: false,
        reason:
          "Denied by policy: set MCPMANAGER_TAILSCALE_ALLOW_KEYS=1 to allow tailscale key creation.",
      };
    }

    const maxExpiry = Number(process.env.MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS ?? "3600");
    const expiry = Number(args?.expirySeconds ?? 0);
    if (!Number.isFinite(expiry) || expiry <= 0 || expiry > maxExpiry) {
      return { ok: false, reason: `Denied by policy: expirySeconds must be 1..${maxExpiry}.` };
    }

    const reusableAllowed = truthy(process.env.MCPMANAGER_TAILSCALE_ALLOW_REUSABLE);
    if (args?.reusable === true && !reusableAllowed) {
      return { ok: false, reason: "Denied by policy: reusable keys are not allowed." };
    }

    if (args?.ephemeral !== true) {
      return { ok: false, reason: "Denied by policy: ephemeral must be true." };
    }

    const lockTailnet = process.env.MCPMANAGER_TAILSCALE_TAILNET_LOCK ?? process.env.TAILSCALE_TAILNET;
    if (lockTailnet && args?.tailnet && args.tailnet !== lockTailnet) {
      return { ok: false, reason: "Denied by policy: tailnet override is not allowed." };
    }

    const allowedTags = (process.env.MCPMANAGER_TAILSCALE_TAGS_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tags: unknown = args?.tags;
    if (!Array.isArray(tags)) {
      return { ok: false, reason: "Denied by policy: tags must be an array." };
    }
    if (allowedTags.length > 0) {
      for (const tag of tags) {
        if (typeof tag !== "string" || !allowedTags.includes(tag)) {
          return { ok: false, reason: "Denied by policy: tags not in allowlist." };
        }
      }
    }

    return { ok: true };
  }

  return { ok: true };
}
