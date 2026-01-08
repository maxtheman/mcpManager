import path from "node:path";

import type { Registry, Upstream } from "../../infra/registry/registry.js";

type ScalePlan = {
  nextRegistry: Registry;
  templateUpstreamId: string;
  idPrefix: string;
  desiredCount: number;
  created: string[];
  updated: string[];
  disabled: string[];
  removed: string[];
  warnings: string[];
};

function defaultPoolEnv(templateId: string): Record<string, string> {
  // Keep npx/bunx caches per-slot to avoid races when scaling up.
  // Use a shared browsers path so only one browser install is needed.
  return {
    NPM_CONFIG_CACHE: path.join("~/.Mx", "pw", "npm-cache", "{id}"),
    npm_config_cache: path.join("~/.Mx", "pw", "npm-cache", "{id}"),
    PLAYWRIGHT_BROWSERS_PATH: path.join("~/.Mx", "pw", "browsers"),
    // Helpful for debugging; not consumed by the upstream directly.
    MX_PLAYWRIGHT_TEMPLATE_ID: templateId,
  };
}

function applyTemplate(value: string, vars: Record<string, string>): string {
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key) => {
    const v = vars[String(key)];
    return v === undefined ? "" : String(v);
  });
}

function renderCloneId(idPrefix: string, index: number): string {
  return `${idPrefix}${index}`;
}

function normalizePerSlotEnv(registry: Registry, templateId: string): Record<string, string> {
  const configured = (registry as any)?.playwright_pool?.per_slot_env;
  const extras =
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? (configured as Record<string, string>)
      : {};
  return { ...defaultPoolEnv(templateId), ...extras };
}

function cloneUpstream(template: Upstream, id: string, envOverrides: Record<string, string>): Upstream {
  return {
    ...template,
    id,
    enabled: true,
    env: { ...(template.env ?? {}), ...envOverrides },
  };
}

function buildDesiredCloneIds(idPrefix: string, desiredCount: number): Set<string> {
  const desired = new Set<string>();
  for (let i = 1; i <= desiredCount; i += 1) desired.add(renderCloneId(idPrefix, i));
  return desired;
}

function computeEnvOverrides(
  envTemplate: Record<string, string>,
  vars: { id: string; index: number; templateUpstreamId: string },
): Record<string, string> {
  const envOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(envTemplate)) {
    envOverrides[k] = applyTemplate(String(v), {
      id: vars.id,
      index: String(vars.index),
      template_upstream_id: vars.templateUpstreamId,
    });
  }
  return envOverrides;
}

function ensureCloneUpstream(params: {
  byId: Map<string, Upstream>;
  template: Upstream;
  templateUpstreamId: string;
  id: string;
  index: number;
  perSlotEnvTemplate: Record<string, string>;
}): { created?: string; updated?: string } {
  const { byId, template, templateUpstreamId, id, index, perSlotEnvTemplate } = params;

  const envOverrides = computeEnvOverrides(perSlotEnvTemplate, { id, index, templateUpstreamId });
  const existing = byId.get(id);
  const next = cloneUpstream(template, id, envOverrides);

  if (!existing) {
    byId.set(id, next);
    return { created: id };
  }

  // Keep existing enablement if user explicitly disabled it, but otherwise normalize.
  const enabled = existing.enabled === false ? false : true;
  // Preserve user env additions, but enforce per-slot overrides last.
  const mergedEnv = { ...(template.env ?? {}), ...(existing.env ?? {}), ...envOverrides };
  // Drop legacy keys; Mx uses MX_* now.
  delete (mergedEnv as any).MCPMANAGER_PLAYWRIGHT_TEMPLATE_ID;
  const merged: Upstream = { ...next, enabled, env: mergedEnv };

  const stableRecordString = (value: Record<string, string> | undefined) => {
    const obj = value ?? {};
    const keys = Object.keys(obj).sort();
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = String(obj[k]);
    return JSON.stringify(out);
  };

  const shouldUpdate =
    existing.command !== merged.command ||
    JSON.stringify(existing.args ?? []) !== JSON.stringify(merged.args ?? []) ||
    JSON.stringify(existing.env_vars ?? []) !== JSON.stringify(merged.env_vars ?? []) ||
    stableRecordString(existing.env) !== stableRecordString(merged.env);

  if (!shouldUpdate) return {};
  byId.set(id, merged);
  return { updated: id };
}

function disableOrRemoveExtraClones(params: {
  byId: Map<string, Upstream>;
  desiredCloneIds: Set<string>;
  templateUpstreamId: string;
  idPrefix: string;
  prune: boolean;
}): { disabled: string[]; removed: string[] } {
  const { byId, desiredCloneIds, templateUpstreamId, idPrefix, prune } = params;
  const disabled: string[] = [];
  const removed: string[] = [];

  const cloneRe = new RegExp(`^${idPrefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\d+)$`);

  for (const [id, u] of Array.from(byId.entries())) {
    if (id === templateUpstreamId) continue;
    const match = cloneRe.exec(id);
    if (!match) continue;
    const idx = Number(match[1]);
    if (!Number.isFinite(idx) || idx <= 0) continue;
    if (desiredCloneIds.has(id)) continue;

    if (prune) {
      byId.delete(id);
      removed.push(id);
      continue;
    }

    if (u.enabled !== false) {
      byId.set(id, { ...u, enabled: false });
      disabled.push(id);
    }
  }

  return { disabled, removed };
}

export function planPlaywrightPoolScale(params: {
  registry: Registry;
  templateUpstreamId: string;
  idPrefix: string;
  count: number;
  prune: boolean;
}): ScalePlan | { ok: false; error: string } {
  const desiredCount = Math.max(0, Math.floor(params.count));
  const { templateUpstreamId, idPrefix, prune } = params;

  const registry = params.registry;
  const byId = new Map<string, Upstream>();
  for (const u of registry.upstreams ?? []) byId.set(u.id, u);

  const template = byId.get(templateUpstreamId);
  if (!template) {
    return { ok: false, error: `Template upstream not found: ${templateUpstreamId}` };
  }

  const warnings: string[] = [];
  if (template.command.trim().length === 0) {
    return { ok: false, error: `Template upstream has empty command: ${templateUpstreamId}` };
  }

  const desiredCloneIds = buildDesiredCloneIds(idPrefix, desiredCount);

  const created: string[] = [];
  const updated: string[] = [];

  const perSlotEnvTemplate = normalizePerSlotEnv(registry, templateUpstreamId);

  // Create/update desired clones.
  for (let i = 1; i <= desiredCount; i += 1) {
    const id = renderCloneId(idPrefix, i);
    const res = ensureCloneUpstream({
      byId,
      template,
      templateUpstreamId,
      id,
      index: i,
      perSlotEnvTemplate,
    });
    if (res.created) created.push(res.created);
    if (res.updated) updated.push(res.updated);
  }

  const { disabled, removed } = disableOrRemoveExtraClones({
    byId,
    desiredCloneIds,
    templateUpstreamId,
    idPrefix,
    prune,
  });

  const nextRegistry: Registry = {
    ...registry,
    playwright_pool: {
      template_upstream_id: templateUpstreamId,
      id_prefix: idPrefix,
      count: desiredCount,
      per_slot_env: (registry as any)?.playwright_pool?.per_slot_env ?? {},
    },
    upstreams: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)),
  };

  if (created.length === 0 && updated.length === 0 && disabled.length === 0 && removed.length === 0) {
    warnings.push("No changes required.");
  }

  return {
    nextRegistry,
    templateUpstreamId,
    idPrefix,
    desiredCount,
    created,
    updated,
    disabled,
    removed,
    warnings,
  };
}
