#!/usr/bin/env bun
/**
 * Test script for Playwright Session Manager
 */

import { SessionManager } from "../src/core/playwright-sessions/session-manager.js";

async function main() {
  console.log("🧪 Testing Playwright Session Manager\n");
  
  const manager = new SessionManager({
    browserOptions: { headless: true }
  });

  try {
    // Test 1: Start a session
    console.log("1️⃣  Starting session...");
    const startResult = await manager.start({
      sessionKey: "test-session",
      ttlSeconds: 300,
      initialUrl: "https://example.com",
      ownerId: "test-agent",
    });
    
    if (!startResult.ok) {
      console.error("❌ Failed to start session:", startResult.error);
      process.exit(1);
    }
    
    console.log("   ✅ Session started:", startResult.sessionId);
    console.log("   📄 Initial page:", startResult.pageId);
    
    const { sessionId, pageId } = startResult;

    // Test 2: Call navigate
    console.log("\n2️⃣  Navigating to httpbin.org...");
    const navResult = await manager.call({
      sessionId,
      tool: "browser_navigate",
      arguments: { url: "https://httpbin.org/html" },
    });
    
    if (!navResult.ok) {
      console.error("❌ Navigate failed:", navResult.error);
    } else {
      console.log("   ✅ Navigation result:", navResult.result);
    }

    // Test 3: Take snapshot
    console.log("\n3️⃣  Taking accessibility snapshot...");
    const snapResult = await manager.call({
      sessionId,
      tool: "browser_snapshot",
      arguments: {},
    });
    
    if (!snapResult.ok) {
      console.error("❌ Snapshot failed:", snapResult.error);
    } else {
      const snapText = String((snapResult.result as any)?.result ?? "");
      console.log("   ✅ Snapshot preview:", snapText.slice(0, 200) + "...");
    }

    // Test 4: List sessions
    console.log("\n4️⃣  Listing sessions...");
    const listResult = manager.list();
    console.log("   ✅ Active sessions:", listResult.sessions.length);
    for (const sess of listResult.sessions) {
      console.log(`      - ${sess.sessionId} (${sess.pageCount} pages, owner: ${sess.ownerId})`);
    }

    // Test 5: Get tabs
    console.log("\n5️⃣  Getting tabs...");
    const tabsResult = await manager.tabs(sessionId);
    if ("error" in tabsResult) {
      console.error("❌ Tabs failed:", tabsResult.error);
    } else {
      console.log("   ✅ Tabs in session:");
      for (const tab of tabsResult.pages) {
        console.log(`      - ${tab.pageId}: ${tab.url} ${tab.isActive ? "(active)" : ""}`);
      }
    }

    // Test 6: Create new tab
    console.log("\n6️⃣  Creating new tab...");
    const newTabResult = await manager.newTab(sessionId, "https://httpbin.org/json");
    if (!newTabResult.ok) {
      console.error("❌ New tab failed:", newTabResult.error);
    } else {
      console.log("   ✅ New tab created:", newTabResult.pageId);
    }

    // Test 7: List tabs again
    console.log("\n7️⃣  Tabs after creating new one...");
    const tabs2Result = await manager.tabs(sessionId);
    if (!("error" in tabs2Result)) {
      for (const tab of tabs2Result.pages) {
        console.log(`      - ${tab.pageId}: ${tab.url} ${tab.isActive ? "(active)" : ""}`);
      }
    }

    // Test 8: Switch active page
    console.log("\n8️⃣  Switching back to first page...");
    const switchOk = manager.setActivePage(sessionId, pageId);
    console.log("   " + (switchOk ? "✅ Switched" : "❌ Failed to switch"));

    // Test 9: Session resume (same key)
    console.log("\n9️⃣  Testing session resume with same key...");
    const resumeResult = await manager.start({
      sessionKey: "test-session",
    });
    if (resumeResult.ok) {
      console.log("   ✅ Session resumed:", resumeResult.reused ? "REUSED existing" : "Created new");
      console.log("   📄 Session ID:", resumeResult.sessionId);
    }

    // Test 10: Inspect session
    console.log("\n🔟 Inspecting session...");
    const inspectResult = await manager.inspect(sessionId);
    if (!("error" in inspectResult)) {
      console.log("   ✅ Session details:");
      console.log(`      - ID: ${inspectResult.sessionId}`);
      console.log(`      - Owner: ${inspectResult.ownerId}`);
      console.log(`      - Status: ${inspectResult.status}`);
      console.log(`      - Pages: ${inspectResult.pages.length}`);
      console.log(`      - TTL: ${inspectResult.ttlSeconds}s remaining`);
    }

    // Test 11: End session
    console.log("\n1️⃣1️⃣ Ending session...");
    const endResult = await manager.end({ sessionId });
    console.log("   " + (endResult.ok ? "✅ Session ended" : `❌ Failed: ${endResult.error}`));

    // Test 12: Verify session is gone
    console.log("\n1️⃣2️⃣ Verifying session cleanup...");
    const finalList = manager.list();
    console.log("   ✅ Remaining sessions:", finalList.sessions.length);

    console.log("\n✨ All tests completed!\n");

  } catch (err) {
    console.error("\n💥 Test error:", err);
    process.exit(1);
  } finally {
    await manager.shutdown();
  }
}

main();
