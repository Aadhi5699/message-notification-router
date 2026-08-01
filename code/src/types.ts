/**
 * types.ts — Strict Zod schemas and inferred TypeScript types for every
 * dataset CSV file plus the required router output format.
 *
 * Every field name matches the exact CSV column header found in ../dataset/.
 * Numeric CSV columns are coerced from strings during parsing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a CSV string to a number (empty string → 0). */
const csvInt = z
  .string()
  .transform((v) => (v === "" ? 0 : Number(v)))
  .pipe(z.number().int());

/** Optional string — empty CSV cell becomes undefined. */
const optStr = z
  .string()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().optional());

// ---------------------------------------------------------------------------
// messages.csv  (also message_history.csv — identical schema)
// ---------------------------------------------------------------------------

export const IncomingMessageSchema = z.object({
  message_id: z.string(),
  user_id: z.string(),
  conversation_type: z.enum(["personal", "group", "business"]),
  group_id: optStr,
  business_id: optStr,
  sender_user_id: optStr,
  created_at: z.string(),
  message_text: optStr,
  media_type: optStr,
  media_id: optStr,
  forwarded_count: csvInt,
});

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

// message_history.csv has the same columns as messages.csv
export const HistoricalMessageSchema = IncomingMessageSchema;
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>;

// ---------------------------------------------------------------------------
// users.csv
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  user_id: z.string(),
  do_not_disturb_window: z.string(),
  messages_opened_30d: csvInt,
  messages_replied_30d: csvInt,
  notifications_dismissed_30d: csvInt,
  messages_reported_30d: csvInt,
});

export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// groups.csv
// ---------------------------------------------------------------------------

export const GroupSchema = z.object({
  group_id: z.string(),
  group_name: z.string(),
  group_type: z.string(),
  member_count: csvInt,
  admin_count: csvInt,
  created_at: z.string(),
  messages_30d: csvInt,
});

export type Group = z.infer<typeof GroupSchema>;

// ---------------------------------------------------------------------------
// group_members.csv
// ---------------------------------------------------------------------------

export const GroupMemberSchema = z.object({
  group_id: z.string(),
  user_id: z.string(),
  role: z.string(),
  joined_at: z.string(),
  messages_sent_30d: csvInt,
  messages_read_30d: csvInt,
  replies_sent_30d: csvInt,
  notifications_dismissed_30d: csvInt,
  group_muted_by_user: csvInt,
});

export type GroupMember = z.infer<typeof GroupMemberSchema>;

// ---------------------------------------------------------------------------
// business_accounts.csv
// ---------------------------------------------------------------------------

export const BusinessAccountSchema = z.object({
  business_id: z.string(),
  display_name: z.string(),
  brand_name: z.string(),
  category: z.string(),
  verified: csvInt,
  official_domain: z.string(),
  domain_used_by_sender: z.string(),
  account_age_days: csvInt,
  messages_sent_30d: csvInt,
  user_reports_30d: csvInt,
  domain_used_by_sender_age_days: csvInt,
});

export type BusinessAccount = z.infer<typeof BusinessAccountSchema>;

// ---------------------------------------------------------------------------
// user_business_history.csv
// ---------------------------------------------------------------------------

export const UserBusinessHistorySchema = z.object({
  user_id: z.string(),
  business_id: z.string(),
  why_user_knows_account: z.string(),
  last_activity_at: optStr,
  allows_promotions: csvInt,
  promotions_opted_out_at: optStr,
  activity_count_180d: csvInt,
  messages_opened_30d: csvInt,
  messages_dismissed_30d: csvInt,
  messages_replied_30d: csvInt,
  last_reply_at: optStr,
});

export type UserBusinessHistory = z.infer<typeof UserBusinessHistorySchema>;

// ---------------------------------------------------------------------------
// message_events.csv
// ---------------------------------------------------------------------------

export const MessageEventSchema = z.object({
  user_id: z.string(),
  message_id: z.string(),
  message_opened: csvInt,
  message_replied: csvInt,
  reaction_time_minutes: csvInt,
  notification_dismissed: csvInt,
  muted_after_message: csvInt,
  message_reported: csvInt,
});

export type MessageEvent = z.infer<typeof MessageEventSchema>;

// ---------------------------------------------------------------------------
// images.csv
// ---------------------------------------------------------------------------

export const ImageRecordSchema = z.object({
  image_id: z.string(),
  file_path: z.string(),
});

export type ImageRecord = z.infer<typeof ImageRecordSchema>;

// ---------------------------------------------------------------------------
// voice_notes.csv
// ---------------------------------------------------------------------------

export const VoiceNoteRecordSchema = z.object({
  voice_note_id: z.string(),
  file_path: z.string(),
});

export type VoiceNoteRecord = z.infer<typeof VoiceNoteRecordSchema>;

// ---------------------------------------------------------------------------
// daily_notification_summary.csv
// ---------------------------------------------------------------------------

export const DailyNotificationSummarySchema = z.object({
  user_id: z.string(),
  date: z.string(),
  notifications_sent: csvInt,
  notifications_dismissed: csvInt,
});

export type DailyNotificationSummary = z.infer<
  typeof DailyNotificationSummarySchema
>;

// ---------------------------------------------------------------------------
// Router output — output.csv
// ---------------------------------------------------------------------------

export const ActionEnum = z.enum(["notify", "digest", "mute"]);
export type Action = z.infer<typeof ActionEnum>;

export const MessageTypeEnum = z.enum([
  "personal",
  "urgent",
  "event",
  "payment",
  "business_update",
  "promotion",
  "greeting",
  "forward",
  "spam",
  "scam",
  "unknown",
]);
export type MessageType = z.infer<typeof MessageTypeEnum>;

export const RoutingDecisionSchema = z.object({
  message_id: z.string(),
  action: ActionEnum,
  message_type: MessageTypeEnum,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence_message_ids: z.string().min(1), // semicolon-separated IDs or "none"
});

export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
