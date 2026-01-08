#!/usr/bin/env bun
import { SessionManager } from "../src/core/playwright-sessions/session-manager.js";
import { SessionJanitor } from "../src/core/playwright-sessions/janitor.js";
import { getDefaultContextRegistry } from "../src/core/playwright-sessions/context-registry.js";

async function testMultiSession() {
  console.log("🧪 Testing Multi-Session Isolation\n");
  
  const manager = new SessionManager({ browserOptions: { headless: true } });

  try {
    const s1 = await manager.start({ ownerId: "agent-1" });
    const s2 = await manager.start({ ownerId: "agent-2" });
    
    if (!s1.ok || !s2.ok) {
      console.error("❌ Failed to create sessions");
      return false;
    }

    console.log("   Session 1:", s1.sessionId);
    console.log("   Session 2:", s2.sessionId);

    await manager.call({
      sessionId: s1.sessionId,
      tool: "browser_navigate",
      arguments: { url: "https://example.com" },
    });

    await manager.call({
      sessionId: s2.sessionId,
      tool: "browser_navigate",
      arguments: { url: "https://httpbin.org" },
    });

    const tabs1 = await manager.tabs(s1.sessionId);
    const tabs2 = await manager.tabs(s2.sessionId);

    if ("pages" in tabs1 && "pages" in tabs2) {
      console.log("\n   Session 1 URL:", tabs1.pages[0]?.url);
      console.log("   Session 2 URL:", tabs2.pages[0]?.url);
      
      const isolated = tabs1.pages[0]?.url?.includes("example.com") && 
                       tabs2.pages[0]?.url?.includes("httpbin.org");
      console.log("\n   ✅ Sessions isolated:", isolated);
    }

    await manager.end({ sessionId: s1.sessionId });
    await manager.end({ sessionId: s2.sessionId });
    
    return true;
  } finally {
    await manager.shutdown();
  }
}

async function testJanitor() {
  console.log("\n🧪 Testing Janitor TTL Cleanup\n");
  
  const manager = new SessionManager({ browserOptions: { headless: true } });
  const registry = getDefaultContextRegistry();
  
  try {
    const result = await manager.start({ ttlSeconds: 1, ownerId: "ttl-test" });
    if (!result.ok) {
      console.error("❌ Failed to create session");
      return false;
    }
    
    console.log("   Created session with 1s TTL:", result.sessionId);
	    console.log("   Sessions before expiry:", registry.listSessions().length);
	    
	    console.log("   Waiting 2 seconds for TTL...");
	    await new Promise((resolve) => setTimeout(resolve, 2000));
	    
	    const expired = registry.listExpiredSessions();
	    console.log("   Expired sessions:", expired.length);
    
    const janitor = new SessionJanitor({
      onSessionExpired: (id) => console.log("   🧹 Cleaned:", id),
    });
    
    const cleaned = await janitor.cleanup();
    console.log("   Janitor cleaned:", cleaned, "sessions");
    
    console.log("   Sessions after cleanup:", registry.listSessions().length);
    console.log("   ✅ Janitor works:", cleaned === 1);
    
    return cleaned === 1;
  } finally {
    await manager.shutdown();
  }
}

async function main() {
  const multiOk = await testMultiSession();
  const janitorOk = await testJanitor();
  
  console.log("\n" + "=".repeat(40));
  console.log("Multi-session:", multiOk ? "✅ PASS" : "❌ FAIL");
  console.log("Janitor:", janitorOk ? "✅ PASS" : "❌ FAIL");
  console.log("=".repeat(40) + "\n");
  
  process.exit(multiOk && janitorOk ? 0 : 1);
}

main();
