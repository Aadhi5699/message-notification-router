/**
 * evidence-retriever.ts — Deterministic historical evidence candidate generation.
 * 
 * Responsibilities:
 * - Retrieve relevant past messages for the current user/context.
 * - Do NOT use unrelated users' history.
 * - Match keyword patterns or recent interactions.
 * - Return structured `HistoricalMessage[]`.
 */

import type { DataStore } from "./data-loader.js";
import type { MessageContext, HistoricalMessage } from "./types.js";

// Extract keywords (length >= 4) from a text
function getKeywords(text: string | undefined): Set<string> {
  const words = (text || "").toLowerCase().match(/\b\w{4,}\b/g) || [];
  return new Set(words);
}

/**
 * Retrieves and ranks historical evidence for the incoming message.
 */
export function retrieveEvidence(ctx: MessageContext, data: DataStore): HistoricalMessage[] {
  const { message } = ctx;
  const rawHistory = data.historyByUser.get(message.user_id) || [];
  
  // 1. Filter history to relevant context (same sender, group, or business)
  let relevantHistory = rawHistory.filter((h) => {
    // Exclude the current message if it somehow appears in history
    if (h.message_id === message.message_id) return false;

    if (message.conversation_type === "personal") {
      return h.sender_user_id === message.sender_user_id && h.conversation_type === "personal";
    } else if (message.conversation_type === "group") {
      return h.group_id === message.group_id;
    } else if (message.conversation_type === "business") {
      return h.business_id === message.business_id;
    }
    return false;
  });

  if (relevantHistory.length === 0) {
    return [];
  }

  // 2. Rank candidates based on keyword patterns and recency
  const currentKeywords = getKeywords(message.message_text);

  const scoredHistory = relevantHistory.map((h) => {
    let score = 0;
    
    // Base score for same sender (important in groups)
    if (message.conversation_type === "group" && h.sender_user_id === message.sender_user_id) {
      score += 1;
    }

    // Keyword overlap
    if (currentKeywords.size > 0 && h.message_text) {
      const histText = h.message_text.toLowerCase();
      let matches = 0;
      for (const kw of currentKeywords) {
        if (histText.includes(kw)) {
          matches++;
        }
      }
      // Weight keyword matches heavily (e.g., finding repeated promotions or greetings)
      score += matches * 2;
    }

    return { msg: h, score };
  });

  // Sort descending by score, then by timestamp (string comparison works for YYYY-MM-DD HH:MM)
  scoredHistory.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.msg.created_at.localeCompare(a.msg.created_at);
  });

  // 3. Return top N most relevant/recent structured messages
  // We limit to top 5 to keep the LLM context focused
  return scoredHistory.slice(0, 5).map((s) => s.msg);
}
