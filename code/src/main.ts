/**
 * main.ts — Production orchestrator for the WhatsApp Message Notification Router.
 *
 * Processes dataset/messages.csv through the routing pipeline.
 * Usage:
 *   npx tsx src/main.ts --limit 1
 *   npx tsx src/main.ts --all
 *   npx tsx src/main.ts --message-id msg_123
 *   npx tsx src/main.ts --force-message msg_123
 *   npx tsx src/main.ts --force-media voice
 */

import "dotenv/config";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringify } from "csv-stringify/sync";

import { loadAllData, DATASET_DIR } from "./data-loader.js";
import { type IncomingMessage, type RoutingDecision, isRoutingFailure } from "./types.js";
import { buildMessageContext } from "./context-builder.js";
import { evaluateSafety } from "./safety-guard.js";
import { retrieveEvidence } from "./evidence-retriever.js";
import { processMedia } from "./multimodal.js";
import { routeMessage } from "./router.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH_DIR = resolve(__dirname, "../scratch");
const CACHE_FILE = resolve(SCRATCH_DIR, "predictions_cache.json");
const OUTPUT_FILE = resolve(DATASET_DIR, "output.csv");

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface CacheEntry {
  prediction: RoutingDecision;
  timestamp: string;
  voice_transcribed?: boolean;
}

type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  limit: number;
  messageId?: string;
  forceMessage?: string;
  forceMedia?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const cliArgs: CliArgs = { limit: 0 };

  const msgIdIdx = args.indexOf("--message-id");
  if (msgIdIdx !== -1 && args[msgIdIdx + 1]) {
    cliArgs.messageId = args[msgIdIdx + 1];
    cliArgs.limit = 1;
    return cliArgs;
  }

  const forceMsgIdx = args.indexOf("--force-message");
  if (forceMsgIdx !== -1 && args[forceMsgIdx + 1]) {
    cliArgs.forceMessage = args[forceMsgIdx + 1];
    cliArgs.limit = 1;
    return cliArgs;
  }

  const forceMediaIdx = args.indexOf("--force-media");
  if (forceMediaIdx !== -1 && args[forceMediaIdx + 1]) {
    cliArgs.forceMedia = args[forceMediaIdx + 1];
  }

  if (args.includes("--all")) {
    cliArgs.limit = Infinity;
    return cliArgs;
  }

  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const n = parseInt(args[limitIdx + 1], 10);
    if (isNaN(n) || n < 1) {
      console.error("Error: --limit must be a positive integer.");
      process.exit(1);
    }
    cliArgs.limit = n;
    return cliArgs;
  }

  if (!cliArgs.forceMedia) {
    console.error("Usage: npx tsx src/main.ts [--limit <N> | --all | --message-id <ID> | --force-message <ID> | --force-media <type>]");
    process.exit(1);
  }

  // If only --force-media is provided, default to --all for that media
  cliArgs.limit = Infinity;
  return cliArgs;
}

// ---------------------------------------------------------------------------
// CSV Generator
// ---------------------------------------------------------------------------

function generateOutputCsv(messages: IncomingMessage[], cache: Cache): void {
  console.log(`\n💾 Generating ${OUTPUT_FILE}...`);
  
  const records = messages.map((msg) => {
    const cached = cache[msg.message_id];
    if (cached) {
      return {
        message_id: msg.message_id,
        action: cached.prediction.action,
        message_type: cached.prediction.message_type,
        reason: cached.prediction.reason,
        confidence: cached.prediction.confidence,
        evidence_message_ids: (cached.prediction.evidence_message_ids || "none").replace(/,\s*/g, ";")
      };
    }
    // Fallback if not evaluated yet (so the CSV always matches messages.csv rows)
    return {
      message_id: msg.message_id,
      action: "",
      message_type: "",
      reason: "",
      confidence: "",
      evidence_message_ids: ""
    };
  });

  const csvContent = stringify(records, {
    header: true,
    columns: ["message_id", "action", "message_type", "reason", "confidence", "evidence_message_ids"],
  });

  writeFileSync(OUTPUT_FILE, csvContent, "utf-8");
  console.log(`✅ output.csv written successfully with ${records.length} rows.`);
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

async function main() {
  const { limit, messageId, forceMessage, forceMedia } = parseArgs();
  console.log(`\n🔄 main: Loading dataset...`);

  // 1. Load data
  const data = await loadAllData();
  const allMessages = data.messages;

  // 2. Print initial counts
  const total = allMessages.length;
  const textCount = allMessages.filter((m) => m.media_type === "" || !m.media_type).length;
  const imageCount = allMessages.filter((m) => m.media_type === "image").length;
  const voiceCount = allMessages.filter((m) => m.media_type === "voice").length;
  
  console.log(`\n📊 Target Messages:`);
  console.log(`  Total: ${total}`);
  console.log(`  Text:  ${textCount}`);
  console.log(`  Image: ${imageCount}`);
  console.log(`  Voice: ${voiceCount}\n`);

  // 3. Load Cache
  const cache = loadCache();
  const cachedCount = Object.keys(cache).length;
  if (cachedCount > 0) {
    console.log(`💾 Cache has ${cachedCount} previously evaluated predictions.`);
  }

  // 4. Determine processing list
  let toProcess: IncomingMessage[] = [];

  if (forceMessage) {
    const target = allMessages.find((s) => s.message_id === forceMessage);
    if (!target) {
      console.error(`❌ Message ID "${forceMessage}" not found.`);
      process.exit(1);
    }
    toProcess = [target];
    console.log(`🎯 Processing specific message (forced): ${forceMessage}`);
  } else if (messageId) {
    const target = allMessages.find((s) => s.message_id === messageId);
    if (!target) {
      console.error(`❌ Message ID "${messageId}" not found.`);
      process.exit(1);
    }
    if (cache[target.message_id]) {
      console.log(`✅ Message ${messageId} is already cached. Skipping.`);
    } else {
      toProcess = [target];
      console.log(`🎯 Processing specific message: ${messageId}`);
    }
  } else {
    // Filter out cached messages unless forced by media type
    let uncached = allMessages;
    
    if (forceMedia) {
      uncached = uncached.filter((m) => m.media_type === forceMedia);
      
      if (forceMedia === "voice") {
        uncached = uncached.filter((m) => {
          const c = cache[m.message_id];
          if (c && c.voice_transcribed === true) return false;
          return true; // Transcribe if uncached or voice_transcribed is false
        });
      }
      
      console.log(`🔍 Forced media type: ${forceMedia} (found ${uncached.length} matching messages to process)`);
    } else {
      uncached = uncached.filter((m) => !cache[m.message_id]);
    }

    toProcess = uncached.slice(0, limit === Infinity ? uncached.length : limit);
    console.log(`🎯 Will process ${toProcess.length} message(s).`);
  }

  if (toProcess.length === 0) {
    console.log("✅ All specified messages are already cached or nothing to do.\n");
  }

  // 5. Process loop
  let successCount = 0;
  let failCount = 0;

  for (const msg of toProcess) {
    const msgId = msg.message_id;
    console.log(`\n--- Processing ${msgId} ---`);

    try {
      const ctx = buildMessageContext(msg, data);
      const safety = evaluateSafety(ctx);
      const evidence = retrieveEvidence(ctx, data);
      const media = await processMedia(ctx, data);

      console.log(`  Safety: flagged=${safety.isFlagged} | Evidence: ${evidence.length} msgs | Media: ${media.type}`);

      const result = await routeMessage(ctx, safety, evidence, media);

      if (isRoutingFailure(result)) {
        console.error(`  ❌ ROUTING FAILED: ${result.error}`);
        failCount++;
        continue;
      }

      const isVoice = media.type === "voice";

      // Checkpoint cache
      cache[msgId] = { 
        prediction: result, 
        timestamp: new Date().toISOString(),
        ...(isVoice ? { voice_transcribed: true } : {})
      };
      saveCache(cache);
      successCount++;

      console.log(`  ✅ Prediction: action=${result.action}, type=${result.message_type}, confidence=${result.confidence}`);
      console.log(`     Reason: ${result.reason}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ PIPELINE ERROR: ${errMsg}`);
      failCount++;
    }
  }

  // 6. Print Run Summary
  console.log("\n" + "=".repeat(80));
  console.log("📊 RUN SUMMARY");
  console.log("=".repeat(80));

  if (toProcess.length > 0) {
    console.log(`  Processed: ${toProcess.length} | Success: ${successCount} | Failed: ${failCount}`);
  }

  const finalCachedCount = Object.keys(cache).length;
  console.log(`  Total cached predictions: ${finalCachedCount} / ${total}`);

  // 7. Write output.csv if we have any cached predictions
  generateOutputCsv(allMessages, cache);

  if (failCount > 0) {
    console.log(`\n⚠️ Some messages failed routing. You can rerun the orchestrator to retry them.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
