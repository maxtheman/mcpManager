import { Daytona } from "@daytonaio/sdk";
import { z } from "zod";

export type DaytonaHandle = {
  createSandbox: (input: {
    target?: string;
    autoStopIntervalMinutes?: number;
    language?: string;
  }) => Promise<{ sandboxId: string }>;
  deleteSandbox: (sandboxId: string) => Promise<void>;
  exec: (sandboxId: string, command: string) => Promise<unknown>;
};

const createSandboxParams = z
  .object({
    target: z.string().optional(),
    autoStopIntervalMinutes: z.number().int().nonnegative().optional(),
    language: z.string().optional(),
  })
  .strict();

export function createDaytonaClient(): DaytonaHandle {
  const envServerUrl =
    process.env.DAYTONA_SERVER_URL ?? process.env.DAYTONA_API_URL;
  const envApiKey = process.env.DAYTONA_API_KEY;
  const envTarget = process.env.DAYTONA_TARGET;

  // Prefer env-driven config to match Daytona's own docs and CLI.
  // If all are present we pass config explicitly; otherwise the SDK reads env vars.
  const client =
    envApiKey && envServerUrl && envTarget
      ? new Daytona({
          apiKey: envApiKey,
          serverUrl: envServerUrl,
          target: envTarget as any,
        } as any)
      : new Daytona();

  return {
    createSandbox: async (raw) => {
      const input = createSandboxParams.parse(raw);
      const workspace = await client.create({
        ...(input.language ? { language: input.language as any } : {}),
        ...(input.autoStopIntervalMinutes !== undefined
          ? { autoStopInterval: input.autoStopIntervalMinutes }
          : {}),
        // `target` is a client-level config in this SDK; ignore here.
        // If you want per-call targets, we can create multiple clients later.
      });
      return { sandboxId: workspace.id };
    },

    deleteSandbox: async (sandboxId) => {
      const workspace = await client.get(sandboxId);
      await client.remove(workspace);
    },

    exec: async (sandboxId, command) => {
      const workspace = await client.get(sandboxId);
      return await workspace.process.executeCommand(command);
    },
  };
}
