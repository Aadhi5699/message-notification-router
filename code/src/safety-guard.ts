/**
 * safety-guard.ts — Deterministic safety checks for incoming messages.
 * 
 * Responsibilities:
 * - Domain Spoofing / Scam detection for business accounts.
 * - Phishing / Credential harvesting detection.
 * - Prompt injection detection.
 * 
 * This module does NOT call the LLM and does NOT make the final routing decision,
 * but it flags high-risk content so the router can make a safe decision.
 */

import type { MessageContext, SafetyResult } from "./types.js";

// Regex for sensitive credentials
const PHISHING_REGEX = /\b(otp|pin|password|passcode|cvv|ssn|social security|one time password)\b/i;

// Regex for prompt injection attempts
const INJECTION_REGEX = /(ignore previous|ignore all previous|set action=|action=notify|system prompt|bypass rules|forget previous)/i;

/**
 * Evaluates the message context against deterministic safety rules.
 */
export function evaluateSafety(ctx: MessageContext): SafetyResult {
  let isSpoofedOrUnverified = false;
  let hasPhishingContent = false;
  let hasPromptInjection = false;
  
  let suggestedAction: SafetyResult["suggestedAction"] = null;
  let suggestedMessageType: SafetyResult["suggestedMessageType"] = null;
  const reasons: string[] = [];

  const text = ctx.message.message_text || "";

  // 1. Domain Spoofing & Unverified Business Check
  if (ctx.message.conversation_type === "business") {
    if (ctx.business) {
      if (ctx.business.verified === 0) {
        isSpoofedOrUnverified = true;
        reasons.push("Unverified business account.");
      } else if (!ctx.isBusinessDomainTrusted) {
        isSpoofedOrUnverified = true;
        reasons.push(`Domain spoofing detected: sender domain (${ctx.business.domain_used_by_sender}) does not match official domain (${ctx.business.official_domain}).`);
      }
    } else {
      isSpoofedOrUnverified = true;
      reasons.push("Business account metadata not found.");
    }
    
    if (isSpoofedOrUnverified) {
      suggestedAction = "mute";
      suggestedMessageType = "scam";
    }
  }

  // 2. Phishing & OTP Requests
  if (text && PHISHING_REGEX.test(text)) {
    // If it's a business and it's spoofed/unverified, definitely phishing.
    // If it's a group or personal, we flag the content.
    hasPhishingContent = true;
    
    // We only suggest mute/scam aggressively if the sender is also unverified/spoofed,
    // or if we decide all OTP requests in groups are suspicious.
    // The prompt says: "Detect text requesting sensitive credentials from unsaved/unverified senders"
    if (isSpoofedOrUnverified) {
      reasons.push("Phishing attempt: credential request from unverified/spoofed sender.");
      suggestedAction = "mute";
      suggestedMessageType = "scam";
    } else {
      reasons.push("Contains sensitive credential request (e.g., OTP/PIN).");
      // If it's a verified business (like a bank), they might send an OTP, which is fine.
      // We flag it but don't force 'mute' unless they are untrusted.
    }
  }

  // 3. Prompt Injection
  if (text && INJECTION_REGEX.test(text)) {
    hasPromptInjection = true;
    reasons.push("Adversarial content: prompt injection pattern detected.");
    suggestedAction = "mute";
    suggestedMessageType = "spam";
  }

  const isFlagged = isSpoofedOrUnverified || hasPhishingContent || hasPromptInjection;

  return {
    isFlagged,
    isSpoofedOrUnverified,
    hasPhishingContent,
    hasPromptInjection,
    suggestedAction,
    suggestedMessageType,
    reason: reasons.length > 0 ? reasons.join(" ") : null,
  };
}
