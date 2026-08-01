/**
 * data-loader.ts — Loads all context CSV files from ../dataset/, validates
 * each row through the Zod schemas in types.ts, and builds deterministic
 * in-memory Map indexes for O(1) lookups.
 *
 * • Paths are resolved relative to this source file (import.meta.dirname),
 *   not the current working directory.
 * • output.csv is never loaded — it is the prediction target, not context.
 * • Nothing under ../dataset/ is modified.
 */

import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse";
import { z } from "zod";

import {
  IncomingMessageSchema,
  UserSchema,
  GroupSchema,
  GroupMemberSchema,
  BusinessAccountSchema,
  UserBusinessHistorySchema,
  HistoricalMessageSchema,
  MessageEventSchema,
  ImageRecordSchema,
  VoiceNoteRecordSchema,
  DailyNotificationSummarySchema,
} from "./types.js";

import type {
  IncomingMessage,
  User,
  Group,
  GroupMember,
  BusinessAccount,
  UserBusinessHistory,
  HistoricalMessage,
  MessageEvent,
  ImageRecord,
  VoiceNoteRecord,
  DailyNotificationSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to dataset/ resolved from this file's location. */
const DATASET_DIR = resolve(import.meta.dirname, "../../dataset");

// ---------------------------------------------------------------------------
// Generic CSV → Zod parser
// ---------------------------------------------------------------------------

/**
 * Reads a CSV file and validates every row against the supplied Zod schema.
 * Rows that fail validation are logged and skipped so a single corrupt row
 * does not crash the pipeline.
 */
async function loadCsv<T>(
  filename: string,
  schema: z.ZodType<T>
): Promise<T[]> {
  const filePath = resolve(DATASET_DIR, filename);
  const records: T[] = [];
  let rowIndex = 0;

  const parser = createReadStream(filePath, { encoding: "utf-8" }).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    })
  );

  for await (const raw of parser) {
    rowIndex++;
    const result = schema.safeParse(raw);
    if (result.success) {
      records.push(result.data);
    } else {
      console.warn(
        `[${filename}] row ${rowIndex}: validation failed —`,
        result.error.flatten().fieldErrors
      );
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Indexed data store
// ---------------------------------------------------------------------------

export interface DataStore {
  /** The incoming messages that need routing decisions. */
  messages: IncomingMessage[];

  // ---- Lookup maps (deterministic, keyed by primary/composite key) --------
  userMap: Map<string, User>;
  groupMap: Map<string, Group>;
  /** Key: `${user_id}:${group_id}` */
  groupMemberMap: Map<string, GroupMember>;
  businessMap: Map<string, BusinessAccount>;
  /** Key: `${user_id}:${business_id}` */
  userBusinessMap: Map<string, UserBusinessHistory>;
  imageMap: Map<string, ImageRecord>;
  voiceNoteMap: Map<string, VoiceNoteRecord>;

  // ---- Grouped collections (one-to-many) ----------------------------------
  /** Historical messages grouped by receiving user_id. */
  historyByUser: Map<string, HistoricalMessage[]>;
  /** Message events grouped by message_id. */
  eventsByMessage: Map<string, MessageEvent[]>;
  /** Daily notification rows grouped by user_id (all dates, chronological). */
  dailyNotifByUser: Map<string, DailyNotificationSummary[]>;

  /** Absolute path to the dataset/ directory. */
  datasetDir: string;
}

/**
 * Loads every context CSV, validates rows, and returns the fully indexed
 * DataStore.  Call this once at startup.
 */
export async function loadAllData(): Promise<DataStore> {
  console.log(`Loading dataset from: ${DATASET_DIR}`);

  const [
    messages,
    users,
    groups,
    groupMembers,
    businessAccounts,
    userBusinessHistory,
    messageHistory,
    messageEvents,
    images,
    voiceNotes,
    dailyNotificationSummary,
  ] = await Promise.all([
    loadCsv("messages.csv", IncomingMessageSchema),
    loadCsv("users.csv", UserSchema),
    loadCsv("groups.csv", GroupSchema),
    loadCsv("group_members.csv", GroupMemberSchema),
    loadCsv("business_accounts.csv", BusinessAccountSchema),
    loadCsv("user_business_history.csv", UserBusinessHistorySchema),
    loadCsv("message_history.csv", HistoricalMessageSchema),
    loadCsv("message_events.csv", MessageEventSchema),
    loadCsv("images.csv", ImageRecordSchema),
    loadCsv("voice_notes.csv", VoiceNoteRecordSchema),
    loadCsv("daily_notification_summary.csv", DailyNotificationSummarySchema),
  ]);

  // -- Single-key Maps (deterministic insertion order) ----------------------

  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.user_id, u);

  const groupMap = new Map<string, Group>();
  for (const g of groups) groupMap.set(g.group_id, g);

  const businessMap = new Map<string, BusinessAccount>();
  for (const b of businessAccounts) businessMap.set(b.business_id, b);

  const imageMap = new Map<string, ImageRecord>();
  for (const i of images) imageMap.set(i.image_id, i);

  const voiceNoteMap = new Map<string, VoiceNoteRecord>();
  for (const v of voiceNotes) voiceNoteMap.set(v.voice_note_id, v);

  // -- Composite-key Maps ---------------------------------------------------

  const groupMemberMap = new Map<string, GroupMember>();
  for (const gm of groupMembers) {
    groupMemberMap.set(`${gm.user_id}:${gm.group_id}`, gm);
  }

  const userBusinessMap = new Map<string, UserBusinessHistory>();
  for (const ubh of userBusinessHistory) {
    userBusinessMap.set(`${ubh.user_id}:${ubh.business_id}`, ubh);
  }

  // -- Grouped collections --------------------------------------------------

  const historyByUser = new Map<string, HistoricalMessage[]>();
  for (const mh of messageHistory) {
    let bucket = historyByUser.get(mh.user_id);
    if (!bucket) {
      bucket = [];
      historyByUser.set(mh.user_id, bucket);
    }
    bucket.push(mh);
  }

  const eventsByMessage = new Map<string, MessageEvent[]>();
  for (const me of messageEvents) {
    let bucket = eventsByMessage.get(me.message_id);
    if (!bucket) {
      bucket = [];
      eventsByMessage.set(me.message_id, bucket);
    }
    bucket.push(me);
  }

  const dailyNotifByUser = new Map<string, DailyNotificationSummary[]>();
  for (const dns of dailyNotificationSummary) {
    let bucket = dailyNotifByUser.get(dns.user_id);
    if (!bucket) {
      bucket = [];
      dailyNotifByUser.set(dns.user_id, bucket);
    }
    bucket.push(dns);
  }

  // -- Summary --------------------------------------------------------------

  console.log(
    [
      `Loaded:`,
      `  ${messages.length} messages to route`,
      `  ${users.length} users`,
      `  ${groups.length} groups`,
      `  ${groupMembers.length} group memberships`,
      `  ${businessAccounts.length} business accounts`,
      `  ${userBusinessHistory.length} user-business relationships`,
      `  ${messageHistory.length} historical messages`,
      `  ${messageEvents.length} message events`,
      `  ${images.length} image records`,
      `  ${voiceNotes.length} voice note records`,
      `  ${dailyNotificationSummary.length} daily notification rows`,
    ].join("\n")
  );

  return {
    messages,
    userMap,
    groupMap,
    groupMemberMap,
    businessMap,
    userBusinessMap,
    historyByUser,
    eventsByMessage,
    imageMap,
    voiceNoteMap,
    dailyNotifByUser,
    datasetDir: DATASET_DIR,
  };
}
