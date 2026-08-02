/**
 * eval-sample.ts — Validates the routing pipeline against dataset/sample_messages.csv.
 *
 * Usage:
 *   npx tsx src/eval-sample.ts --limit 1    # process 1 uncached message
 *   npx tsx src/eval-sample.ts --limit 5    # process up to 5 uncached messages
 *   npx tsx src/eval-sample.ts --all        # process all 50 sample messages
 *
 * Caching:
 *   Every successful prediction is saved to scratch/sample_eval_cache.json
 *   keyed by message_id. Rerunning the evaluator skips already-cached messages.
 *
 * Ground truth comparison:
 *   sample_messages.csv includes ground-truth labels (action, message_type).
 *   After routing, the script prints a side-by-side comparison table.
 */

import "dotenv/config";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadAllData, loadCsv } from "./data-loader.js";
import { IncomingMessageSchema, type IncomingMessage, type RoutingDecision, isRoutingFailure } from "./types.js";
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
const CACHE_FILE = resolve(SCRATCH_DIR, "sample_eval_cache.json");

// ---------------------------------------------------------------------------
// Zod schema for sample_messages.csv (incoming message + ground-truth labels)
// ---------------------------------------------------------------------------

import { z } from "zod";

const csvInt = z
  .string()
  .transform((v) => (v === "" ? 0 : Number(v)))
  .pipe(z.number().int());

const optStr = z
  .string()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().optional());

/** sample_messages.csv has the same columns as messages.csv + ground-truth labels. */
const SampleMessageSchema = z.object({
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
  // Ground-truth labels
  action: z.string(),
  message_type: z.string(),
  reason: z.string(),
  confidence: z.string(),
  evidence_message_ids: z.string(),
});

type SampleMessage = z.infer<typeof SampleMessageSchema>;

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface CacheEntry {
  prediction: RoutingDecision;
  timestamp: string;
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
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // --message-id <ID> — process a single specific message (ignores cache)
  const msgIdIdx = args.indexOf("--message-id");
  if (msgIdIdx !== -1 && args[msgIdIdx + 1]) {
    return { limit: 1, messageId: args[msgIdIdx + 1] };
  }

  if (args.includes("--all")) {
    return { limit: Infinity };
  }

  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const n = parseInt(args[limitIdx + 1], 10);
    if (isNaN(n) || n < 1) {
      console.error("Error: --limit must be a positive integer.");
      process.exit(1);
    }
    return { limit: n };
  }

  console.error("Usage: npx tsx src/eval-sample.ts --limit <N> | --all | --message-id <ID>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function main() {
  const { limit, messageId } = parseArgs();
  console.log(`\n🔄 eval-sample: Loading dataset...`);

  // 1. Load all context data (users, groups, businesses, history, etc.)
  const data = await loadAllData();

  // 2. Load sample messages (with ground truth)
  const samples = await loadCsv("sample_messages.csv", SampleMessageSchema);
  console.log(`📋 Loaded ${samples.length} sample messages with ground truth.`);

  // 3. Load cache
  const cache = loadCache();
  const cachedCount = Object.keys(cache).length;
  if (cachedCount > 0) {
    console.log(`💾 Cache has ${cachedCount} previously evaluated predictions.`);
  }

  // 4. Determine which messages need processing
  let toProcess: SampleMessage[];

  if (messageId) {
    // --message-id mode: find the specific message, ignore cache
    const target = samples.find((s) => s.message_id === messageId);
    if (!target) {
      console.error(`❌ Message ID "${messageId}" not found in sample_messages.csv`);
      process.exit(1);
    }
    toProcess = [target];
    console.log(`🎯 Processing specific message: ${messageId} (cache bypassed)`);
  } else {
    // --limit / --all mode: skip cached messages
    const uncached = samples.filter((s) => !cache[s.message_id]);
    toProcess = uncached.slice(0, limit === Infinity ? uncached.length : limit);
    console.log(`🎯 Will process ${toProcess.length} uncached message(s) (${uncached.length} total uncached, limit=${limit === Infinity ? "all" : limit}).`);
  }

  if (toProcess.length === 0) {
    console.log("✅ All messages already cached. Nothing to do.\n");
  }

  // 5. Process each message through the full pipeline
  let successCount = 0;
  let failCount = 0;

  for (const sample of toProcess) {
    const msgId = sample.message_id;
    console.log(`\n--- Processing ${msgId} ---`);

    // Convert the sample row into an IncomingMessage (strip ground-truth fields)
    const incomingMsg: IncomingMessage = {
      message_id: sample.message_id,
      user_id: sample.user_id,
      conversation_type: sample.conversation_type,
      group_id: sample.group_id,
      business_id: sample.business_id,
      sender_user_id: sample.sender_user_id,
      created_at: sample.created_at,
      message_text: sample.message_text,
      media_type: sample.media_type,
      media_id: sample.media_id,
      forwarded_count: sample.forwarded_count,
    };

    try {
      // Pipeline: context → safety → evidence → multimodal → router
      const ctx = buildMessageContext(incomingMsg, data);
      const safety = evaluateSafety(ctx);
      const evidence = retrieveEvidence(ctx, data);
      const media = processMedia(ctx, data);

      console.log(`  Safety: flagged=${safety.isFlagged} | Evidence: ${evidence.length} msgs | Media: ${media.type}`);

      const result = await routeMessage(ctx, safety, evidence, media);

      if (isRoutingFailure(result)) {
        console.error(`  ❌ ROUTING FAILED: ${result.error}`);
        failCount++;
        continue;
      }

      // Cache the successful prediction immediately
      cache[msgId] = { prediction: result, timestamp: new Date().toISOString() };
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

  // 6. Summary report — compare cached predictions vs ground truth
  console.log("\n" + "=".repeat(80));
  console.log("📊 EVALUATION SUMMARY");
  console.log("=".repeat(80));

  if (toProcess.length > 0) {
    console.log(`  Processed: ${toProcess.length} | Success: ${successCount} | Failed: ${failCount}`);
  }

  // Comparison table for all cached predictions
  const allCached = samples.filter((s) => cache[s.message_id]);
  if (allCached.length === 0) {
    console.log("  No cached predictions to compare yet.\n");
    return;
  }

  let actionMatch = 0;
  let typeMatch = 0;

  console.log(`\n  Comparing ${allCached.length} cached predictions against ground truth:\n`);
  console.log(
    "  " +
    padRight("message_id", 20) +
    padRight("GT action", 12) +
    padRight("Pred action", 13) +
    padRight("Match", 8) +
    padRight("GT type", 18) +
    padRight("Pred type", 18) +
    "Match"
  );
  console.log("  " + "-".repeat(95));

  for (const sample of allCached) {
    const pred = cache[sample.message_id].prediction;
    const aMatch = sample.action === pred.action;
    const tMatch = sample.message_type === pred.message_type;
    if (aMatch) actionMatch++;
    if (tMatch) typeMatch++;

    console.log(
      "  " +
      padRight(sample.message_id, 20) +
      padRight(sample.action, 12) +
      padRight(pred.action, 13) +
      padRight(aMatch ? "✅" : "❌", 8) +
      padRight(sample.message_type, 18) +
      padRight(pred.message_type, 18) +
      (tMatch ? "✅" : "❌")
    );
  }

  console.log("  " + "-".repeat(95));
  console.log(`  Action accuracy:  ${actionMatch}/${allCached.length} (${((actionMatch / allCached.length) * 100).toFixed(1)}%)`);
  console.log(`  Type accuracy:    ${typeMatch}/${allCached.length} (${((typeMatch / allCached.length) * 100).toFixed(1)}%)`);
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
