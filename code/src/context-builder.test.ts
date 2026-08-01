/**
 * Unit & Integration tests for context-builder.ts
 */

import { loadAllData } from "./data-loader.js";
import {
  checkQuietHours,
  computeNotificationLoad,
  buildMessageContext,
} from "./context-builder.js";
import type { IncomingMessage } from "./types.js";

async function runTests() {
  console.log("=== Testing context-builder.ts ===\n");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // Test 1: checkQuietHours
  // -------------------------------------------------------------------------
  console.log("Test Suite 1: Quiet Hours Calculation");
  assert(checkQuietHours("2026-07-30 22:19", "22:00-07:00") === true, "22:19 is inside 22:00-07:00 DND");
  assert(checkQuietHours("2026-07-30 14:16", "22:00-07:00") === false, "14:16 is outside 22:00-07:00 DND");
  assert(checkQuietHours("2026-07-31 06:59", "22:00-07:00") === true, "06:59 is inside 22:00-07:00 DND");
  assert(checkQuietHours("2026-07-31 07:01", "22:00-07:00") === false, "07:01 is outside 22:00-07:00 DND");
  assert(checkQuietHours("2026-07-31 03:00", "01:00-06:00") === true, "03:00 is inside same-day 01:00-06:00 DND");

  // -------------------------------------------------------------------------
  // Load data for integration tests
  // -------------------------------------------------------------------------
  const data = await loadAllData();

  // -------------------------------------------------------------------------
  // Test 2: computeNotificationLoad
  // -------------------------------------------------------------------------
  console.log("\nTest Suite 2: Notification Load Calculation");
  const loadStats = computeNotificationLoad(data, "u_001");
  assert(loadStats.totalSent > 0, "u_001 has >0 total sent notifications");
  assert(loadStats.daysCovered === 14, "u_001 has 14 days covered");
  assert(loadStats.dismissRate >= 0 && loadStats.dismissRate <= 1, "u_001 dismiss rate is calibrated [0, 1]");

  // -------------------------------------------------------------------------
  // Test 3: buildMessageContext — Personal Message
  // -------------------------------------------------------------------------
  console.log("\nTest Suite 3: Personal Message Context Resolution");
  const personalMsg = data.messages.find((m) => m.conversation_type === "personal");
  if (personalMsg) {
    const ctx = buildMessageContext(personalMsg, data);
    assert(ctx.user.user_id === personalMsg.user_id, "Receiver user resolved correctly");
    assert(ctx.senderUser !== undefined, "Sender user profile resolved for personal chat");
    assert(ctx.senderUser?.user_id === personalMsg.sender_user_id, "Sender user ID matches");
    assert(ctx.group === undefined, "Group is undefined for personal message");
    assert(ctx.business === undefined, "Business is undefined for personal message");
  } else {
    assert(false, "No personal message found in dataset");
  }

  // -------------------------------------------------------------------------
  // Test 4: buildMessageContext — Group Message
  // -------------------------------------------------------------------------
  console.log("\nTest Suite 4: Group Message Context Resolution");
  const groupMsg = data.messages.find((m) => m.conversation_type === "group");
  if (groupMsg) {
    const ctx = buildMessageContext(groupMsg, data);
    assert(ctx.group !== undefined, "Group metadata resolved");
    assert(ctx.group?.group_id === groupMsg.group_id, "Group ID matches");
    assert(ctx.receiverGroupMembership !== undefined, "Receiver group membership resolved");
    assert(ctx.senderGroupMembership !== undefined, "Sender group membership resolved");
  } else {
    assert(false, "No group message found in dataset");
  }

  // -------------------------------------------------------------------------
  // Test 5: buildMessageContext — Business Message & Domain Trust
  // -------------------------------------------------------------------------
  console.log("\nTest Suite 5: Business Message Context Resolution");
  const bizMsg = data.messages.find((m) => m.conversation_type === "business");
  if (bizMsg) {
    const ctx = buildMessageContext(bizMsg, data);
    assert(ctx.business !== undefined, "Business metadata resolved");
    assert(ctx.business?.business_id === bizMsg.business_id, "Business ID matches");
    assert(typeof ctx.isBusinessDomainTrusted === "boolean", "isBusinessDomainTrusted boolean computed");
  } else {
    assert(false, "No business message found in dataset");
  }

  // -------------------------------------------------------------------------
  // Test 6: buildMessageContext — Missing User Throws Error
  // -------------------------------------------------------------------------
  console.log("\nTest Suite 6: Error Handling for Missing User");
  const invalidMsg: IncomingMessage = {
    message_id: "invalid_msg_999",
    user_id: "user_non_existent_999",
    conversation_type: "personal",
    sender_user_id: "u_001",
    created_at: "2026-07-31 10:00",
    message_text: "Hello",
    media_type: undefined,
    media_id: undefined,
    forwarded_count: 0,
  };

  let threwError = false;
  try {
    buildMessageContext(invalidMsg, data);
  } catch (err: any) {
    threwError = true;
    assert(err.message.includes("user_non_existent_999"), "Error message mentions missing user ID");
  }
  assert(threwError, "buildMessageContext threw Error for non-existent user");

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n==================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed.`);
  console.log(`==================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
