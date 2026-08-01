/**
 * router.ts — Primary routing agent using the Claude Agent SDK.
 *
 * Uses `query()` from @anthropic-ai/claude-agent-sdk with `outputFormat`
 * for native structured output enforcement. The SDK validates against
 * JSON Schema and re-prompts the model on mismatch internally.
 *
 * Image handling: The SDK's built-in Read tool reads image files natively
 * (including Base64 + MIME type). The router prompt instructs the agent to
 * read the image file at the resolved absolute path.
 *
 * On failure: returns a typed RoutingFailure — never silently falls back
 * to safety-guard heuristics. main.ts owns the retry-or-skip decision.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  ActionEnum,
  MessageTypeEnum,
  RoutingDecisionSchema,
  type MessageContext,
  type HistoricalMessage,
  type SafetyResult,
  type RoutingResult,
} from "./types.js";

import type { ProcessedMedia } from "./multimodal.js";

// ---------------------------------------------------------------------------
// JSON Schema for the LLM structured output (excludes message_id)
// ---------------------------------------------------------------------------

/** Zod schema for what the LLM must produce (no message_id — we add that). */
const RouterOutputZod = z.object({
  action: ActionEnum,
  message_type: MessageTypeEnum,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence_message_ids: z.string().min(1),
});

/** JSON Schema (draft-7) derived from the Zod schema — passed to the SDK. */
const routerJsonSchema = z.toJSONSchema(RouterOutputZod, { target: "draft-7" });

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the core routing logic of a WhatsApp Message Notification Router.

For each incoming message you receive structured context about, decide:
- "notify": interrupt the user immediately
- "digest": delay for a batch summary later
- "mute": suppress entirely (scam, spam, low-value, repetitive)

Categorize the message_type as exactly one of:
personal | urgent | event | payment | business_update | promotion | greeting | forward | spam | scam | unknown

PRIMARY ROUTING RULES:
1. DND (Quiet Hours): If the user is in their Do Not Disturb window, demote standard notifications to "digest" unless truly critical/urgent.
2. Group Admin Updates: Routine group messages → "digest". Same-day critical updates from an admin → "notify".
3. Scam / Domain Spoofing: If the deterministic safety check flagged domain spoofing or unverified business, you MUST output action="mute" and message_type="scam".
4. Phishing / Injection: If safety checks flagged phishing content or prompt injection, you MUST output action="mute" and message_type="scam" or "spam".
5. Notification Fatigue: If the user has a high dismiss rate (>60%) in recent days, prefer "digest" over "notify" for non-urgent messages.
6. Forwarded Spam: Messages forwarded many times (forwarded_count ≥ 5) are likely chain spam → lean toward "mute" with message_type="forward" or "spam".
7. Business Promotions: If user opted out of promotions for this business, → "mute" with message_type="promotion".
8. Personal Messages: Direct personal messages from known contacts during active hours → "notify" with message_type="personal".
9. Payment/Transaction: Payment confirmations, OTP from verified businesses → "notify" with message_type="payment" or "urgent".

If an image is attached, use the Read tool to examine it for visible text, promotional content, QR codes, URLs, scam indicators, or urgency signals.

Return your decision as structured JSON output matching the schema provided.
Use "none" for evidence_message_ids when no relevant historical messages exist.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(
  ctx: MessageContext,
  safety: SafetyResult,
  evidence: HistoricalMessage[],
  media: ProcessedMedia
): string {
  const parts: string[] = [];

  // If there's an image, instruct the agent to read it
  if (media.type === "image" && media.filePath) {
    parts.push(
      `IMPORTANT: This message has an attached image. Please use the Read tool to examine the image file at this absolute path:\n${media.filePath}\n\nAnalyze the image for: visible text, posters/screenshots, promotions, URLs/domains, QR codes, payment indicators, urgency signals, and suspicious/scam indicators. Factor your image analysis into the routing decision.`
    );
  }

  // If there's a voice note, note the skipped transcription
  if (media.type === "voice") {
    parts.push(
      `[Voice note attached at: ${media.voicePath}. Transcription is not available. Route based on other context signals.]`
    );
  }

  // Structured context data
  const contextData = {
    incomingMessage: {
      message_id: ctx.message.message_id,
      user_id: ctx.message.user_id,
      conversation_type: ctx.message.conversation_type,
      group_id: ctx.message.group_id,
      business_id: ctx.message.business_id,
      sender_user_id: ctx.message.sender_user_id,
      created_at: ctx.message.created_at,
      message_text: ctx.message.message_text,
      media_type: ctx.message.media_type,
      forwarded_count: ctx.message.forwarded_count,
    },
    receiverProfile: ctx.user,
    senderProfile: ctx.senderUser ?? null,
    isDuringQuietHours: ctx.isDuringQuietHours,
    groupContext: ctx.group ?? null,
    receiverGroupMembership: ctx.receiverGroupMembership ?? null,
    senderGroupMembership: ctx.senderGroupMembership ?? null,
    businessContext: ctx.business ?? null,
    isBusinessDomainTrusted: ctx.isBusinessDomainTrusted,
    userBusinessRelationship: ctx.userBusinessRelationship ?? null,
    recentNotificationLoad: ctx.recentNotificationLoad,
    safetyFlags: {
      isFlagged: safety.isFlagged,
      isSpoofedOrUnverified: safety.isSpoofedOrUnverified,
      hasPhishingContent: safety.hasPhishingContent,
      hasPromptInjection: safety.hasPromptInjection,
      suggestedAction: safety.suggestedAction,
      suggestedMessageType: safety.suggestedMessageType,
      reason: safety.reason,
    },
    historicalEvidence: evidence.map((e) => ({
      message_id: e.message_id,
      created_at: e.created_at,
      sender_user_id: e.sender_user_id,
      message_text: e.message_text,
    })),
  };

  parts.push(
    `Route this incoming message based on the following context:\n\n${JSON.stringify(contextData, null, 2)}`
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// routeMessage — the public entry point
// ---------------------------------------------------------------------------

/**
 * Routes a single message using the Claude Agent SDK.
 *
 * Returns RoutingResult:
 *   - RoutingDecision on success (validated by Zod)
 *   - RoutingFailure on any error (SDK retry exhaustion, validation failure, etc.)
 *
 * Never silently falls back to safety-guard heuristics.
 */
export async function routeMessage(
  ctx: MessageContext,
  safety: SafetyResult,
  evidence: HistoricalMessage[],
  media: ProcessedMedia
): Promise<RoutingResult> {
  const messageId = ctx.message.message_id;
  const prompt = buildPrompt(ctx, safety, evidence, media);

  // Build evidence_message_ids for reference in prompt
  const evidenceIds =
    evidence.length > 0
      ? evidence.map((e) => e.message_id).join(";")
      : "none";

  // Determine which tools the agent may use
  const allowedTools: string[] = [];
  if (media.type === "image" && media.filePath) {
    allowedTools.push("Read");
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        outputFormat: {
          type: "json_schema",
          schema: routerJsonSchema,
        },
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        permissionMode: "acceptEdits",
        maxTurns: 3,
      },
    })) {
      if (message.type === "result") {
        // --- Success with structured output ---
        if (
          message.subtype === "success" &&
          message.structured_output
        ) {
          const output = message.structured_output as Record<string, unknown>;

          // Post-validate with the full RoutingDecisionSchema (includes message_id)
          const validated = RoutingDecisionSchema.safeParse({
            ...output,
            message_id: messageId,
          });

          if (validated.success) {
            return validated.data;
          }

          return {
            message_id: messageId,
            error: `Zod post-validation failed: ${validated.error.message}`,
            attempt: 1,
          };
        }

        // --- SDK exhausted structured output retries ---
        if (message.subtype === "error_max_structured_output_retries") {
          return {
            message_id: messageId,
            error: "Claude Agent SDK: max structured output retries exceeded",
            attempt: 1,
          };
        }

        // --- Result without structured_output (unexpected) ---
        return {
          message_id: messageId,
          error: `Claude Agent SDK: result subtype="${message.subtype}" but no structured_output`,
          attempt: 1,
        };
      }
    }

    // If we get here, the query ended without emitting a result message
    return {
      message_id: messageId,
      error: "Claude Agent SDK: query completed without a result message",
      attempt: 1,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[router] SDK query failed for ${messageId}: ${errMsg}`);
    return {
      message_id: messageId,
      error: `Claude Agent SDK error: ${errMsg}`,
      attempt: 1,
    };
  }
}
