/**
 * context-builder.ts — Constructs a personalized, deterministic context for one
 * incoming message using the indexes from data-loader.ts.
 */

import type { DataStore } from "./data-loader.js";
import type { IncomingMessage, MessageContext, NotificationLoad } from "./types.js";

/**
 * Checks if a message timestamp falls within a user's DND (Do Not Disturb) window.
 * DND window format expected: "HH:MM-HH:MM" (e.g. "22:00-07:00").
 */
export function checkQuietHours(createdAt: string, dndWindow: string): boolean {
  if (!dndWindow || !dndWindow.includes("-")) {
    return false;
  }

  // Extract time "HH:MM" from "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM:SS"
  const timeMatch = createdAt.match(/(\d{2}):(\d{2})/);
  if (!timeMatch) {
    return false;
  }

  const msgMinutes = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);

  const [startStr, endStr] = dndWindow.split("-");
  const startMatch = startStr.match(/(\d{2}):(\d{2})/);
  const endMatch = endStr.match(/(\d{2}):(\d{2})/);

  if (!startMatch || !endMatch) {
    return false;
  }

  const startMinutes = parseInt(startMatch[1], 10) * 60 + parseInt(startMatch[2], 10);
  const endMinutes = parseInt(endMatch[1], 10) * 60 + parseInt(endMatch[2], 10);

  if (startMinutes > endMinutes) {
    // Window spans across midnight (e.g. 22:00 - 07:00)
    return msgMinutes >= startMinutes || msgMinutes < endMinutes;
  } else {
    // Window is within the same day (e.g. 01:00 - 06:00)
    return msgMinutes >= startMinutes && msgMinutes < endMinutes;
  }
}

/**
 * Computes aggregated notification load stats for a user from their daily notification rows.
 */
export function computeNotificationLoad(data: DataStore, userId: string): NotificationLoad {
  const rows = data.dailyNotifByUser.get(userId) || [];
  let totalSent = 0;
  let totalDismissed = 0;

  for (const r of rows) {
    totalSent += r.notifications_sent;
    totalDismissed += r.notifications_dismissed;
  }

  const dismissRate = totalSent > 0 ? totalDismissed / totalSent : 0;

  return {
    totalSent,
    totalDismissed,
    dismissRate: Math.round(dismissRate * 1000) / 1000,
    daysCovered: rows.length,
  };
}

/**
 * Builds a personalized MessageContext for a given incoming message.
 * Throws an Error if the receiving user is not found in users.csv.
 */
export function buildMessageContext(
  message: IncomingMessage,
  data: DataStore
): MessageContext {
  // 1. Resolve receiver user profile (REQUIRED — throw if missing)
  const user = data.userMap.get(message.user_id);
  if (!user) {
    throw new Error(
      `Receiver user ${message.user_id} not found in users.csv for message ${message.message_id}`
    );
  }

  // 2. Check DND / quiet hours
  const isDuringQuietHours = checkQuietHours(message.created_at, user.do_not_disturb_window);

  // 3. Sender user profile (for personal/direct chats or sender profile lookup)
  const senderUser = message.sender_user_id
    ? data.userMap.get(message.sender_user_id)
    : undefined;

  // 4. Group context
  let group = undefined;
  let receiverGroupMembership = undefined;
  let senderGroupMembership = undefined;

  if (message.conversation_type === "group" && message.group_id) {
    group = data.groupMap.get(message.group_id);
    receiverGroupMembership = data.groupMemberMap.get(`${message.user_id}:${message.group_id}`);
    if (message.sender_user_id) {
      senderGroupMembership = data.groupMemberMap.get(
        `${message.sender_user_id}:${message.group_id}`
      );
    }
  }

  // 5. Business context
  let business = undefined;
  let userBusinessRelationship = undefined;
  let isBusinessDomainTrusted = false;

  if (message.conversation_type === "business" && message.business_id) {
    business = data.businessMap.get(message.business_id);
    userBusinessRelationship = data.userBusinessMap.get(
      `${message.user_id}:${message.business_id}`
    );

    if (business) {
      isBusinessDomainTrusted =
        business.verified === 1 &&
        business.official_domain === business.domain_used_by_sender;
    }
  }

  // 6. Recent notification load
  const recentNotificationLoad = computeNotificationLoad(data, message.user_id);

  return {
    message,
    user,
    isDuringQuietHours,
    senderUser,
    group,
    receiverGroupMembership,
    senderGroupMembership,
    business,
    isBusinessDomainTrusted,
    userBusinessRelationship,
    recentNotificationLoad,
  };
}
