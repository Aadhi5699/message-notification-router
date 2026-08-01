/**
 * FK verification — checks that foreign-key joins resolve correctly
 * for ALL incoming messages, not just a sample.
 */
import { loadAllData } from "./data-loader.js";

async function main() {
  const d = await loadAllData();

  let totalErrors = 0;

  // -----------------------------------------------------------------------
  // 1. Every message must have a valid receiving user
  // -----------------------------------------------------------------------
  console.log("--- User FK Check (all messages) ---");
  let missingUsers = 0;
  for (const m of d.messages) {
    const user = d.userMap.get(m.user_id);
    if (!user) {
      console.error(`  ✗ ${m.message_id}: receiver ${m.user_id} NOT in users.csv`);
      missingUsers++;
    }
  }
  console.log(
    missingUsers === 0
      ? `  ✓ All ${d.messages.length} messages have a valid receiver user`
      : `  ✗ ${missingUsers}/${d.messages.length} messages have missing receiver users`
  );
  totalErrors += missingUsers;

  // -----------------------------------------------------------------------
  // 2. Group messages: receiver + sender membership in group_members
  // -----------------------------------------------------------------------
  const groupMsgs = d.messages.filter((m) => m.conversation_type === "group");
  console.log(`\n--- Group FK Check (${groupMsgs.length} messages) ---`);

  let missingGroup = 0;
  let missingReceiverMembership = 0;
  let missingSenderMembership = 0;

  for (const g of groupMsgs) {
    // Group must exist
    const group = d.groupMap.get(g.group_id!);
    if (!group) {
      console.error(`  ✗ ${g.message_id}: group ${g.group_id} NOT in groups.csv`);
      missingGroup++;
    }

    // Receiver membership
    const receiverKey = `${g.user_id}:${g.group_id}`;
    const receiverMem = d.groupMemberMap.get(receiverKey);
    if (!receiverMem) {
      console.error(
        `  ✗ ${g.message_id}: receiver ${g.user_id} NOT a member of ${g.group_id}`
      );
      missingReceiverMembership++;
    }

    // Sender membership
    if (g.sender_user_id) {
      const senderKey = `${g.sender_user_id}:${g.group_id}`;
      const senderMem = d.groupMemberMap.get(senderKey);
      if (!senderMem) {
        console.error(
          `  ✗ ${g.message_id}: sender ${g.sender_user_id} NOT a member of ${g.group_id}`
        );
        missingSenderMembership++;
      }
    }
  }

  console.log(`  Groups missing:            ${missingGroup}/${groupMsgs.length}`);
  console.log(`  Receiver memberships missing: ${missingReceiverMembership}/${groupMsgs.length}`);
  console.log(`  Sender memberships missing:   ${missingSenderMembership}/${groupMsgs.length}`);
  totalErrors += missingGroup + missingReceiverMembership + missingSenderMembership;

  // -----------------------------------------------------------------------
  // 3. Business messages: business account + user-business history
  // -----------------------------------------------------------------------
  const bizMsgs = d.messages.filter((m) => m.conversation_type === "business");
  console.log(`\n--- Business FK Check (${bizMsgs.length} messages) ---`);

  let missingBusiness = 0;
  let missingUBH = 0;
  let domainMismatch = 0;

  for (const b of bizMsgs) {
    const biz = d.businessMap.get(b.business_id!);
    if (!biz) {
      console.error(`  ✗ ${b.message_id}: business ${b.business_id} NOT in business_accounts.csv`);
      missingBusiness++;
    } else {
      // Check domain trust
      if (biz.official_domain !== biz.domain_used_by_sender) {
        domainMismatch++;
      }
    }

    const ubhKey = `${b.user_id}:${b.business_id}`;
    const ubh = d.userBusinessMap.get(ubhKey);
    if (!ubh) {
      console.warn(
        `  ⚠ ${b.message_id}: user ${b.user_id} has NO history with ${b.business_id}`
      );
      missingUBH++;
    }
  }

  console.log(`  Businesses missing:        ${missingBusiness}/${bizMsgs.length}`);
  console.log(`  User-business history gaps: ${missingUBH}/${bizMsgs.length} (warn, not error)`);
  console.log(`  Domain mismatches:         ${domainMismatch}/${bizMsgs.length}`);
  totalErrors += missingBusiness;

  // -----------------------------------------------------------------------
  // 4. Personal messages: sender user existence
  // -----------------------------------------------------------------------
  const personalMsgs = d.messages.filter((m) => m.conversation_type === "personal");
  console.log(`\n--- Personal FK Check (${personalMsgs.length} messages) ---`);

  let missingSender = 0;
  for (const p of personalMsgs) {
    if (p.sender_user_id) {
      const sender = d.userMap.get(p.sender_user_id);
      if (!sender) {
        console.error(
          `  ✗ ${p.message_id}: sender ${p.sender_user_id} NOT in users.csv`
        );
        missingSender++;
      }
    }
  }

  console.log(
    missingSender === 0
      ? `  ✓ All ${personalMsgs.length} personal messages have valid senders`
      : `  ✗ ${missingSender}/${personalMsgs.length} personal messages have missing senders`
  );
  totalErrors += missingSender;

  // -----------------------------------------------------------------------
  // 5. Daily notification summary coverage
  // -----------------------------------------------------------------------
  console.log(`\n--- Daily Notification Coverage ---`);
  const uniqueUsers = new Set(d.messages.map((m) => m.user_id));
  let missingDailyNotif = 0;
  for (const uid of uniqueUsers) {
    const rows = d.dailyNotifByUser.get(uid);
    if (!rows || rows.length === 0) {
      console.error(`  ✗ ${uid}: no daily notification data`);
      missingDailyNotif++;
    }
  }
  console.log(
    missingDailyNotif === 0
      ? `  ✓ All ${uniqueUsers.size} unique users have daily notification data`
      : `  ✗ ${missingDailyNotif}/${uniqueUsers.size} users missing daily notification data`
  );
  totalErrors += missingDailyNotif;

  // -----------------------------------------------------------------------
  // 6. Media references
  // -----------------------------------------------------------------------
  const mediaMsgs = d.messages.filter((m) => m.media_id);
  console.log(`\n--- Media FK Check (${mediaMsgs.length} messages) ---`);
  let missingMedia = 0;
  for (const m of mediaMsgs) {
    if (m.media_type === "image") {
      if (!d.imageMap.get(m.media_id!)) {
        console.error(`  ✗ ${m.message_id}: image ${m.media_id} NOT in images.csv`);
        missingMedia++;
      }
    } else if (m.media_type === "voice") {
      if (!d.voiceNoteMap.get(m.media_id!)) {
        console.error(`  ✗ ${m.message_id}: voice_note ${m.media_id} NOT in voice_notes.csv`);
        missingMedia++;
      }
    }
  }
  console.log(
    missingMedia === 0
      ? `  ✓ All ${mediaMsgs.length} media references resolve`
      : `  ✗ ${missingMedia}/${mediaMsgs.length} media references missing`
  );
  totalErrors += missingMedia;

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Total messages checked: ${d.messages.length}`);
  console.log(`Total FK errors: ${totalErrors}`);
  console.log(`User-business history gaps (warnings): ${missingUBH}`);
  console.log(`Domain mismatches: ${domainMismatch}`);
  console.log(`${"=".repeat(50)}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main();
