import { z } from "zod";

export type TailscaleHandle = { apiKey: string };

const createKeyInput = z
  .object({
    tailnet: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).default([]),
    expirySeconds: z.number().int().positive().default(3600),
    reusable: z.boolean().default(false),
    ephemeral: z.boolean().default(true),
    preauthorized: z.boolean().default(true),
    description: z.string().optional(),
  })
  .strict();

function tailscaleBase64Basic(apiKey: string): string {
  // Tailscale API uses HTTP Basic Auth with username=API key and empty password.
  return Buffer.from(`${apiKey}:`, "utf8").toString("base64");
}

function requireApiKey(handle: TailscaleHandle): string {
  if (!handle.apiKey) {
    throw new Error("TAILSCALE_API_KEY is required.");
  }
  return handle.apiKey;
}

export async function listDevices(
  handle: TailscaleHandle,
  tailnet = "-",
): Promise<unknown> {
  const apiKey = requireApiKey(handle);
  const resp = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`,
    {
      headers: {
        Authorization: `Basic ${tailscaleBase64Basic(apiKey)}`,
        Accept: "application/json",
      },
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Tailscale devices request failed (${resp.status}): ${body || resp.statusText}`,
    );
  }
  return await resp.json();
}

export async function createEphemeralKey(
  handle: TailscaleHandle,
  rawInput: unknown,
): Promise<{ key: string }> {
  const apiKey = requireApiKey(handle);
  const input = createKeyInput.parse(rawInput);
  const tailnet = input.tailnet ?? "-";

  const resp = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${tailscaleBase64Basic(apiKey)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: input.reusable,
              ephemeral: input.ephemeral,
              preauthorized: input.preauthorized,
              tags: input.tags,
            },
          },
        },
        expirySeconds: input.expirySeconds,
        description: input.description ?? "mcpManager auth key",
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Tailscale key create failed (${resp.status}): ${body || resp.statusText}`,
    );
  }

  const json = (await resp.json()) as any;
  const key = json?.key ?? "";
  if (!key) throw new Error("Tailscale key response missing `key`.");
  return { key };
}

