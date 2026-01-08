import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  die,
  log,
  parseJsonText,
  isTruthy,
  createTestContext,
  writeTestRegistry,
  isLockValid,
  captureSnapshot,
  formatSnapshot,
  ensureGatewayBinary,
  TestAssertions,
  type TestContext,
  type Json,
} from "./test-utils.js";

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

type SessionInfo = {
  sessionId: string;
  upstreamId: string;
  tabIndex: number;
};

type AgentState = {
  id: string;
  client: Client;
  session: SessionInfo | null;
  navigatedUrl: string | null;
  snapshotLength: number;
};

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args as Record<string, Json> });
  const first = (res as { content?: Array<{ text?: string }> })?.content?.[0];
  const text = typeof first?.text === "string" ? first.text : "";
  return { text, json: parseJsonText(text) as Record<string, unknown> };
}

async function createSingleGatewayClient(
  gatewayExe: string,
  env: Record<string, string>
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: gatewayExe,
    env: { ...filterEnv(process.env), ...env },
  });
  const client = new Client(
    { name: "isolation-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function acquireSession(
  client: Client,
  agentId: string,
  ttlSeconds = 180
): Promise<SessionInfo> {
  log(agentId, "Acquiring playwright session...");
  const result = await callText(client, "playwright_pool_session_start", { ttlSeconds });

  if (!result.json?.ok) {
    die(`[${agentId}] Failed to acquire session: ${result.text}`);
  }

  const session: SessionInfo = {
    sessionId: String(result.json.sessionId),
    upstreamId: String(result.json.upstreamId),
    tabIndex: Number(result.json.tabIndex ?? -1),
  };

  log(agentId, `Acquired session: upstream=${session.upstreamId}, tab=${session.tabIndex}`);
  return session;
}

async function navigateAndSnapshot(
  client: Client,
  agentId: string,
  session: SessionInfo,
  url: string
): Promise<{ snapshotLength: number }> {
  log(agentId, `Navigating to ${url}...`);
  const nav = await callText(client, "playwright_pool_session_call", {
    sessionId: session.sessionId,
    tool: "browser_navigate",
    arguments: { url },
  });

  if (!nav.text) {
    die(`[${agentId}] Navigate returned empty output`);
  }

  log(agentId, "Taking snapshot...");
  const snap = await callText(client, "playwright_pool_session_call", {
    sessionId: session.sessionId,
    tool: "browser_snapshot",
    arguments: {},
  });

  if (!snap.text) {
    die(`[${agentId}] Snapshot returned empty output`);
  }

  log(agentId, `Snapshot captured: ${snap.text.length} bytes`);
  return { snapshotLength: snap.text.length };
}

async function releaseSession(
  client: Client,
  agentId: string,
  session: SessionInfo
): Promise<void> {
  log(agentId, "Releasing session...");
  const result = await callText(client, "playwright_pool_session_end", {
    sessionId: session.sessionId,
  });

  if (!result.json?.ok) {
    die(`[${agentId}] Failed to release session: ${result.text}`);
  }

  log(agentId, "Session released");
}

async function verifyPoolStatus(
  client: Client,
  tag: string,
  expectedHeld: number,
  assertions: TestAssertions
): Promise<void> {
  const result = await callText(client, "playwright_pool_list", {});
  const pool = result.json?.pool as Array<{ upstreamId: string; locked: boolean }> | undefined;

  if (!pool) {
    assertions.assert(false, `${tag}: Failed to get pool status`);
    return;
  }

  const lockedCount = pool.filter((s) => s.locked).length;
  assertions.assertEqual(lockedCount, expectedHeld, `${tag}: Expected ${expectedHeld} locked slots`);

  log(tag, `Pool status: ${lockedCount}/${pool.length} locked`);
}

async function testSingleGatewayIsolation(ctx: TestContext, gatewayExe: string) {
  const assertions = new TestAssertions("isolation");

  log("test", "Creating single gateway client for concurrent agent simulation...");
  const client = await createSingleGatewayClient(gatewayExe, ctx.env);

  const agentA: AgentState = { id: "A", client, session: null, navigatedUrl: null, snapshotLength: 0 };
  const agentB: AgentState = { id: "B", client, session: null, navigatedUrl: null, snapshotLength: 0 };

  try {
    log("test", "Phase 1: Both agents acquire sessions concurrently");
    const [sessionA, sessionB] = await Promise.all([
      acquireSession(client, "A"),
      acquireSession(client, "B"),
    ]);

    agentA.session = sessionA;
    agentB.session = sessionB;

    assertions.assertNotEqual(
      sessionA.upstreamId,
      sessionB.upstreamId,
      "Agents should get different upstreamIds"
    );

    log("test", "Phase 2: Verify lock files exist on disk");
  const snapshot1 = await captureSnapshot(ctx.locksDir, ["Mx-gateway"]);
    log("test", formatSnapshot(snapshot1));

    const lockA = snapshot1.lockFiles.get(sessionA.upstreamId) ?? null;
    const lockB = snapshot1.lockFiles.get(sessionB.upstreamId) ?? null;

    assertions.assert(isLockValid(lockA), `Lock file for ${sessionA.upstreamId} should exist and be valid`);
    assertions.assert(isLockValid(lockB), `Lock file for ${sessionB.upstreamId} should exist and be valid`);

    if (lockA && lockB) {
      assertions.assertEqual(lockA.pid, lockB.pid, "Both locks should have same PID (same gateway)");
    }

    log("test", "Phase 3: Verify pool shows both slots locked");
    await verifyPoolStatus(client, "both-held", 2, assertions);

    log("test", "Phase 4: Both agents navigate concurrently to different URLs");
    const urlA = "https://example.com/";
    const urlB = "https://example.org/";

    const [navResultA, navResultB] = await Promise.all([
      navigateAndSnapshot(client, "A", sessionA, urlA),
      navigateAndSnapshot(client, "B", sessionB, urlB),
    ]);

    agentA.navigatedUrl = urlA;
    agentA.snapshotLength = navResultA.snapshotLength;
    agentB.navigatedUrl = urlB;
    agentB.snapshotLength = navResultB.snapshotLength;

    assertions.assert(navResultA.snapshotLength > 0, "Agent A should have non-empty snapshot");
    assertions.assert(navResultB.snapshotLength > 0, "Agent B should have non-empty snapshot");

    log("test", "Phase 5: Release agent A, verify agent B still holds lock");
    await releaseSession(client, "A", sessionA);
    agentA.session = null;

    const snapshot2 = await captureSnapshot(ctx.locksDir);
    const lockAAfter = snapshot2.lockFiles.get(sessionA.upstreamId) ?? null;
    const lockBAfter = snapshot2.lockFiles.get(sessionB.upstreamId) ?? null;

    assertions.assert(!isLockValid(lockAAfter), `Lock for ${sessionA.upstreamId} should be released`);
    assertions.assert(isLockValid(lockBAfter), `Lock for ${sessionB.upstreamId} should still be valid`);

    await verifyPoolStatus(client, "a-released", 1, assertions);

    log("test", "Phase 6: Release agent B, verify all locks released");
    await releaseSession(client, "B", sessionB);
    agentB.session = null;

    const snapshot3 = await captureSnapshot(ctx.locksDir);
    const allLocksReleased = Array.from(snapshot3.lockFiles.values()).every((lock) => !isLockValid(lock));
    assertions.assert(allLocksReleased, "All locks should be released");

    await verifyPoolStatus(client, "all-released", 0, assertions);

    log("test", "Phase 7: Both agents can reacquire");
    const [reacquireA, reacquireB] = await Promise.all([
      acquireSession(client, "A"),
      acquireSession(client, "B"),
    ]);

    assertions.assertNotEqual(
      reacquireA.upstreamId,
      reacquireB.upstreamId,
      "Reacquired sessions should have different upstreamIds"
    );

    await Promise.all([
      releaseSession(client, "A", reacquireA),
      releaseSession(client, "B", reacquireB),
    ]);

  } finally {
	    if (agentA.session) {
	      try {
	        await releaseSession(client, "A", agentA.session);
	      } catch {
	        // best-effort cleanup
	      }
	    }
	    if (agentB.session) {
	      try {
	        await releaseSession(client, "B", agentB.session);
	      } catch {
	        // best-effort cleanup
	      }
	    }
	    await client.close();
	  }

  assertions.throwIfFailed();
}

async function testConcurrentNavigationRace(ctx: TestContext, gatewayExe: string) {
  const assertions = new TestAssertions("race");

  log("race", "Testing concurrent navigation race conditions...");
  const client = await createSingleGatewayClient(gatewayExe, ctx.env);

  try {
    const session = await acquireSession(client, "race");

    log("race", "Firing 3 concurrent navigations to same session (should serialize or fail safely)");
    const urls = [
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page3",
    ];

    const results = await Promise.allSettled(
      urls.map((url) =>
        callText(client, "playwright_pool_session_call", {
          sessionId: session.sessionId,
          tool: "browser_navigate",
          arguments: { url },
        })
      )
    );

    const successes = results.filter((r) => r.status === "fulfilled").length;
    const failures = results.filter((r) => r.status === "rejected").length;

    log("race", `Results: ${successes} succeeded, ${failures} failed`);

    assertions.assert(
      successes >= 1,
      "At least one navigation should succeed"
    );

    await releaseSession(client, "race", session);

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function testSessionKeyReuse(ctx: TestContext, gatewayExe: string) {
  const assertions = new TestAssertions("session-key");

  log("session-key", "Testing session key reuse behavior...");
  const client = await createSingleGatewayClient(gatewayExe, ctx.env);

  try {
    const sessionKey = "test-session-key-123";

    log("session-key", "First acquisition with sessionKey");
    const result1 = await callText(client, "playwright_pool_session_start", {
      ttlSeconds: 180,
      sessionKey,
    });

    assertions.assert(result1.json?.ok === true, "First acquisition should succeed");
    const sessionId1 = String(result1.json?.sessionId);
    const upstreamId1 = String(result1.json?.upstreamId);

    log("session-key", "Second acquisition with same sessionKey (should reuse)");
    const result2 = await callText(client, "playwright_pool_session_start", {
      ttlSeconds: 180,
      sessionKey,
    });

    assertions.assert(result2.json?.ok === true, "Second acquisition should succeed");
    assertions.assertEqual(
      String(result2.json?.sessionId),
      sessionId1,
      "Should return same sessionId"
    );
    assertions.assertEqual(
      result2.json?.reused,
      true,
      "Should indicate session was reused"
    );

    log("session-key", "Releasing session");
    await releaseSession(client, "session-key", {
      sessionId: sessionId1,
      upstreamId: upstreamId1,
      tabIndex: Number(result1.json?.tabIndex ?? 0),
    });

    log("session-key", "Third acquisition after release (should get new session)");
    const result3 = await callText(client, "playwright_pool_session_start", {
      ttlSeconds: 180,
      sessionKey,
    });

    assertions.assert(result3.json?.ok === true, "Third acquisition should succeed");
    assertions.assertNotEqual(
      String(result3.json?.sessionId),
      sessionId1,
      "Should get new sessionId after release"
    );

    await releaseSession(client, "session-key", {
      sessionId: String(result3.json?.sessionId),
      upstreamId: String(result3.json?.upstreamId),
      tabIndex: Number(result3.json?.tabIndex ?? 0),
    });

  } finally {
    await client.close();
  }

  assertions.throwIfFailed();
}

async function main() {
  const headed = isTruthy(process.env.MX_PLAYWRIGHT_HEADED) ||
    process.env.MX_PLAYWRIGHT_HEADLESS === "0";

  log("main", `Playwright isolation test (headed=${headed})`);

  const gatewayExe = await ensureGatewayBinary();
  const ctx = await createTestContext("pw-isolation");

  const commonArgs = ["-y", "@playwright/mcp@latest", "--isolated"];
  if (!headed) commonArgs.push("--headless");

  await writeTestRegistry(ctx.registryPath, [
    {
      id: "pw1",
      command: "bunx",
      args: commonArgs,
      env: {
        NPM_CONFIG_CACHE: path.join(ctx.tempDir, "npm-cache", "pw1"),
        npm_config_cache: path.join(ctx.tempDir, "npm-cache", "pw1"),
        PLAYWRIGHT_BROWSERS_PATH: path.join(ctx.tempDir, "ms-playwright"),
      },
    },
    {
      id: "pw2",
      command: "bunx",
      args: commonArgs,
      env: {
        NPM_CONFIG_CACHE: path.join(ctx.tempDir, "npm-cache", "pw2"),
        npm_config_cache: path.join(ctx.tempDir, "npm-cache", "pw2"),
        PLAYWRIGHT_BROWSERS_PATH: path.join(ctx.tempDir, "ms-playwright"),
      },
    },
  ]);

  ctx.env.MX_PLAYWRIGHT_POOL = "pw1,pw2";

  log("main", `Temp dir: ${ctx.tempDir}`);
  log("main", `Registry: ${ctx.registryPath}`);

  try {
    await testSingleGatewayIsolation(ctx, gatewayExe);
    log("main", "");

    await testConcurrentNavigationRace(ctx, gatewayExe);
    log("main", "");

    await testSessionKeyReuse(ctx, gatewayExe);
    log("main", "");

    log("main", "All isolation tests passed");

  } finally {
    const finalSnapshot = await captureSnapshot(ctx.locksDir, ["Mx-gateway", "@playwright/mcp"]);
    log("main", "Final state:\n" + formatSnapshot(finalSnapshot));

    await ctx.cleanup();
  }
}

await main();
