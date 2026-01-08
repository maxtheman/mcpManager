import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  die,
  log,
  wait,
  parseJsonText,
  createTestContext,
  writeTestRegistry,
  findProcessesByName,
  captureSnapshot,
  formatSnapshot,
  ensureGatewayBinary,
  TestAssertions,
  type TestContext,
  type Json,
  type ProcessInfo,
} from "./test-utils.js";

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as Record<string, Json> });
  const first = (res as { content?: Array<{ text?: string }> })?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) as Record<string, unknown> };
}

async function createGatewayClient(
  gatewayExe: string,
  env: Record<string, string>
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...filterEnv(process.env), ...env },
  });
  const client = new Client(
    { name: "interactions-lifecycle-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function countClaudeProcesses(): Promise<ProcessInfo[]> {
  return findProcessesByName("claude.*--print.*stream-json");
}

async function testSessionCreationAndCleanup(ctx: TestContext, gatewayExe: string, model: string) {
  const assertions = new TestAssertions("session-cleanup");

  log("session-cleanup", "Testing session creation and cleanup...");
  const client = await createGatewayClient(gatewayExe, ctx.env);

  const processesBefore = await countClaudeProcesses();
  log("session-cleanup", `Claude processes before: ${processesBefore.length}`);

  try {
    log("session-cleanup", "Creating interaction (store=false for immediate cleanup)...");
    const result = await callText(client, "interactions_create", {
      model,
      input: "Reply with exactly: test-cleanup-response",
      permissionless: true,
      store: false,
    });

    if (!result.json?.id) {
      assertions.assert(false, `Failed to create interaction: ${result.text}`);
      return;
    }

    const interactionId = String(result.json.id);
    log("session-cleanup", `Created interaction: ${interactionId}`);

    const status = String(result.json.status);
    log("session-cleanup", `Status: ${status}`);

    if (status === "in_progress") {
      log("session-cleanup", "Waiting for completion...");
      for (let i = 0; i < 30; i++) {
        await wait(1000);
        const poll = await callText(client, "interactions_get", { id: interactionId });
        if (poll.json?.status !== "in_progress") {
          log("session-cleanup", `Final status: ${poll.json?.status}`);
          break;
        }
      }
    }

    await wait(2000);

    const processesAfter = await countClaudeProcesses();
    log("session-cleanup", `Claude processes after (store=false): ${processesAfter.length}`);

    assertions.assertEqual(
      processesAfter.length,
      processesBefore.length,
      "store=false should clean up Claude process immediately"
    );

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function testSessionLeakageDetection(ctx: TestContext, gatewayExe: string, model: string) {
  const assertions = new TestAssertions("leakage");

  log("leakage", "Testing for session leakage...");
  const client = await createGatewayClient(gatewayExe, ctx.env);

  const processesBefore = await countClaudeProcesses();
  log("leakage", `Claude processes before: ${processesBefore.length}`);

  const createdIds: string[] = [];

  try {
    log("leakage", "Creating multiple interactions without explicit cleanup...");
    
    for (let i = 0; i < 3; i++) {
      const result = await callText(client, "interactions_create", {
        model,
        input: `Reply with exactly: leakage-test-${i}`,
        permissionless: true,
        background: true,
      });

      if (result.json?.id) {
        createdIds.push(String(result.json.id));
        log("leakage", `Created interaction ${i}: ${result.json.id}`);
      }
    }

    log("leakage", "Waiting for all to complete...");
    for (let attempt = 0; attempt < 60; attempt++) {
      await wait(1000);
      let allDone = true;
      for (const id of createdIds) {
        const poll = await callText(client, "interactions_get", { id });
        if (poll.json?.status === "in_progress") {
          allDone = false;
          break;
        }
      }
      if (allDone) break;
    }

    const processesAfterComplete = await countClaudeProcesses();
    log("leakage", `Claude processes after completion: ${processesAfterComplete.length}`);

    log("leakage", "Closing gateway client (simulating disconnect)...");
    await client.close();

    await wait(3000);

    const processesAfterClose = await countClaudeProcesses();
    log("leakage", `Claude processes after client close: ${processesAfterClose.length}`);

    const leakedProcesses = processesAfterClose.filter(
      (p) => !processesBefore.some((bp) => bp.pid === p.pid)
    );

    if (leakedProcesses.length > 0) {
      log("leakage", `LEAK DETECTED: ${leakedProcesses.length} orphaned processes`, "error");
      for (const p of leakedProcesses) {
        log("leakage", `  - PID ${p.pid}: ${p.command.slice(0, 80)}`, "error");
      }
    }

    assertions.assertEqual(
      leakedProcesses.length,
      0,
      "Should not leak Claude processes after client disconnects"
    );

  } catch (e) {
    log("leakage", `Error during test: ${e}`, "error");
    throw e;
  }

  assertions.throwIfFailed();
}

async function testSessionReuse(ctx: TestContext, gatewayExe: string, model: string) {
  const assertions = new TestAssertions("session-reuse");

  log("session-reuse", "Testing session reuse via previous_interaction_id...");
  const client = await createGatewayClient(gatewayExe, ctx.env);

  try {
    log("session-reuse", "Creating first interaction...");
    const first = await callText(client, "interactions_create", {
      model,
      input: "Remember the secret word: BANANA. Reply with 'Remembered.'",
      permissionless: true,
    });

    if (!first.json?.id) {
      assertions.assert(false, `Failed to create first interaction: ${first.text}`);
      return;
    }

    const firstId = String(first.json.id);
    log("session-reuse", `First interaction: ${firstId}`);

    if (first.json.status === "in_progress") {
      for (let i = 0; i < 30; i++) {
        await wait(1000);
        const poll = await callText(client, "interactions_get", { id: firstId });
        if (poll.json?.status !== "in_progress") break;
      }
    }

    log("session-reuse", "Creating follow-up interaction with previous_interaction_id...");
    const second = await callText(client, "interactions_create", {
      model,
      input: "What was the secret word I told you to remember?",
      previous_interaction_id: firstId,
      permissionless: true,
    });

    if (!second.json?.id) {
      assertions.assert(false, `Failed to create follow-up interaction: ${second.text}`);
      return;
    }

    const secondId = String(second.json.id);
    log("session-reuse", `Follow-up interaction: ${secondId}`);

    if (second.json.status === "in_progress") {
      for (let i = 0; i < 30; i++) {
        await wait(1000);
        const poll = await callText(client, "interactions_get", { id: secondId });
        if (poll.json?.status !== "in_progress") {
          log("session-reuse", `Follow-up output: ${String(poll.json?.output ?? "").slice(0, 100)}`);
          break;
        }
      }
    }

    const finalPoll = await callText(client, "interactions_get", { id: secondId });
    const output = String(finalPoll.json?.output ?? "").toLowerCase();
    
    assertions.assertContains(
      output,
      "banana",
      "Follow-up should remember context from first interaction"
    );

    log("session-reuse", "Cleaning up...");
    await callText(client, "interactions_delete", { id: firstId });
    await callText(client, "interactions_delete", { id: secondId });

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function testConcurrentInteractions(ctx: TestContext, gatewayExe: string, model: string) {
  const assertions = new TestAssertions("concurrent");

  log("concurrent", "Testing concurrent interaction handling...");
  const client = await createGatewayClient(gatewayExe, ctx.env);

  const createdIds: string[] = [];

  try {
    log("concurrent", "Creating 3 concurrent background interactions...");
    
    const createPromises = [
      callText(client, "interactions_create", {
        model,
        input: "Reply with exactly: concurrent-a",
        permissionless: true,
        background: true,
      }),
      callText(client, "interactions_create", {
        model,
        input: "Reply with exactly: concurrent-b",
        permissionless: true,
        background: true,
      }),
      callText(client, "interactions_create", {
        model,
        input: "Reply with exactly: concurrent-c",
        permissionless: true,
        background: true,
      }),
    ];

    const createResults = await Promise.all(createPromises);
    
    for (const result of createResults) {
      if (result.json?.id) {
        createdIds.push(String(result.json.id));
        assertions.assertEqual(
          result.json.status,
          "in_progress",
          "Background interaction should start in_progress"
        );
      } else {
        assertions.assert(false, `Failed to create interaction: ${result.text}`);
      }
    }

    log("concurrent", `Created ${createdIds.length} interactions: ${createdIds.join(", ")}`);

    log("concurrent", "Waiting for all to complete...");
    const completedOutputs = new Map<string, string>();

    for (let attempt = 0; attempt < 60; attempt++) {
      await wait(1000);
      
      for (const id of createdIds) {
        if (completedOutputs.has(id)) continue;
        
        const poll = await callText(client, "interactions_get", { id });
        if (poll.json?.status === "completed") {
          completedOutputs.set(id, String(poll.json.output ?? ""));
          log("concurrent", `Completed: ${id}`);
        } else if (poll.json?.status === "failed") {
          assertions.assert(false, `Interaction ${id} failed: ${poll.json.error}`);
          completedOutputs.set(id, "FAILED");
        }
      }

      if (completedOutputs.size === createdIds.length) break;
    }

    assertions.assertEqual(
      completedOutputs.size,
      createdIds.length,
      "All concurrent interactions should complete"
    );

    log("concurrent", "Cleaning up...");
    for (const id of createdIds) {
      await callText(client, "interactions_delete", { id });
    }

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function testCancellation(ctx: TestContext, gatewayExe: string, model: string) {
  const assertions = new TestAssertions("cancellation");

  log("cancellation", "Testing interaction cancellation...");
  const client = await createGatewayClient(gatewayExe, ctx.env);

  try {
    log("cancellation", "Creating a slow interaction...");
    const result = await callText(client, "interactions_create", {
      model,
      input: "Write a very long essay about the history of computing. Make it at least 1000 words.",
      permissionless: true,
      background: true,
    });

    if (!result.json?.id) {
      assertions.assert(false, `Failed to create interaction: ${result.text}`);
      return;
    }

    const interactionId = String(result.json.id);
    log("cancellation", `Created interaction: ${interactionId}`);

    await wait(2000);

    const beforeCancel = await callText(client, "interactions_get", { id: interactionId });
    log("cancellation", `Status before cancel: ${beforeCancel.json?.status}`);

    log("cancellation", "Cancelling interaction...");
    const cancelResult = await callText(client, "interactions_cancel", { id: interactionId });
    log("cancellation", `Cancel result: ${cancelResult.json?.status}`);

    assertions.assertEqual(
      cancelResult.json?.status,
      "cancelled",
      "Cancelled interaction should have status 'cancelled'"
    );

    await wait(2000);

    const processesAfter = await countClaudeProcesses();
    log("cancellation", `Claude processes after cancel: ${processesAfter.length}`);

    await callText(client, "interactions_delete", { id: interactionId });

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function main() {
  const model = process.env.MX_INTERACTIONS_MODEL;
  if (!model) {
    die("Set MX_INTERACTIONS_MODEL to a Claude CLI model name (e.g., claude-sonnet-4-20250514)");
  }

  log("main", `Interactions lifecycle test (model=${model})`);

  const gatewayExe = await ensureGatewayBinary();
  const ctx = await createTestContext("interactions-lifecycle");

  await writeTestRegistry(ctx.registryPath, []);

  log("main", `Temp dir: ${ctx.tempDir}`);
  log("main", `Registry: ${ctx.registryPath}`);

  const initialSnapshot = await captureSnapshot(ctx.locksDir, ["claude.*stream-json"]);
  log("main", "Initial state:\n" + formatSnapshot(initialSnapshot));

  try {
    await testSessionCreationAndCleanup(ctx, gatewayExe, model);
    log("main", "");

    await testSessionReuse(ctx, gatewayExe, model);
    log("main", "");

    await testConcurrentInteractions(ctx, gatewayExe, model);
    log("main", "");

    await testCancellation(ctx, gatewayExe, model);
    log("main", "");

    await testSessionLeakageDetection(ctx, gatewayExe, model);
    log("main", "");

    log("main", "All interactions lifecycle tests passed");

  } finally {
    const finalSnapshot = await captureSnapshot(ctx.locksDir, ["claude.*stream-json"]);
    log("main", "Final state:\n" + formatSnapshot(finalSnapshot));

    await ctx.cleanup();
  }
}

await main();
