/**
 * Smoke test — verify that data-loader.ts parses the full dataset without
 * errors and that the Map indexes are populated.
 */

import { loadAllData } from "./data-loader.js";

async function main() {
  const data = await loadAllData();

  // Basic assertions
  const checks: [string, boolean][] = [
    ["messages.length > 0", data.messages.length > 0],
    ["userMap.size > 0", data.userMap.size > 0],
    ["groupMap.size > 0", data.groupMap.size > 0],
    ["groupMemberMap.size > 0", data.groupMemberMap.size > 0],
    ["businessMap.size > 0", data.businessMap.size > 0],
    ["userBusinessMap.size > 0", data.userBusinessMap.size > 0],
    ["historyByUser.size > 0", data.historyByUser.size > 0],
    ["eventsByMessage.size > 0", data.eventsByMessage.size > 0],
    ["imageMap.size > 0", data.imageMap.size > 0],
    ["voiceNoteMap.size > 0", data.voiceNoteMap.size > 0],
    ["dailyNotifByUser.size > 0", data.dailyNotifByUser.size > 0],
  ];

  console.log("\n--- Smoke Test Results ---");
  let passed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (ok) passed++;
  }
  console.log(`\n${passed}/${checks.length} checks passed.`);

  // Print a sample message to verify structure
  console.log("\n--- Sample Message ---");
  console.log(JSON.stringify(data.messages[0], null, 2));

  // Print a sample user
  const sampleUserId = data.messages[0].user_id;
  const sampleUser = data.userMap.get(sampleUserId);
  console.log("\n--- Sample User ---");
  console.log(JSON.stringify(sampleUser, null, 2));

  if (passed < checks.length) {
    process.exit(1);
  }
}

main();
