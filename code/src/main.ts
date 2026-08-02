import "dotenv/config";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringify } from "csv-stringify/sync";

import { loadAllData, DATASET_DIR } from "./data-loader.js";
import { type IncomingMessage, type RoutingDecision, type ReviewerVerdict, isRoutingFailure } from "./types.js";
import { buildMessageContext } from "./context-builder.js";
import { evaluateSafety } from "./safety-guard.js";
import { retrieveEvidence } from "./evidence-retriever.js";
import { processMedia } from "./multimodal.js";
import { needsReview, reviewMessage } from "./reviewer.js";
import { judgeMessage } from "./judge.js";
import { isReviewerFailure } from "./types.js";
import { routeMessage } from "./router.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH_DIR = resolve(__dirname, "../scratch");
const CACHE_FILE = resolve(SCRATCH_DIR, "predictions_cache.json");
const REVIEW_CACHE_FILE = resolve(SCRATCH_DIR, "review_cache.json");
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

interface ReviewCacheEntry {
  reviewerVerdict: ReviewerVerdict;
  judgeDecision?: RoutingDecision;
  timestamp: string;
}

type ReviewCache = Record<string, ReviewCacheEntry>;

function loadReviewCache(): ReviewCache {
  if (!existsSync(REVIEW_CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REVIEW_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveReviewCache(cache: ReviewCache): void {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  writeFileSync(REVIEW_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  limit: number;
  messageId?: string;
  reviewStats?: boolean;
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

  if (args.includes("--review-stats")) {
    cliArgs.reviewStats = true;
    cliArgs.limit = Infinity;
    return cliArgs;
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

  console.error("Usage: npx tsx src/main.ts [--limit <N> | --all | --message-id <ID>]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CSV Generator
// ---------------------------------------------------------------------------

function generateOutputCsv(messages: IncomingMessage[], cache: Cache): void {
  console.log(`\nGenerating ${OUTPUT_FILE}...`);
  
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
    return {
      message_id: msg.message_id,
      action: "",
      message_type: "",
      reason: "",
      confidence: "",
      evidence_message_ids: ""
    };
  });

  const csvString = stringify(records, { header: true });
  writeFileSync(OUTPUT_FILE, csvString, "utf-8");
  console.log(`Saved output to ${OUTPUT_FILE}`);
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

async function run() {
  const { limit, messageId, reviewStats } = parseArgs();

  console.log("Loading datasets...");
  const data = await loadAllData();
  const allMessages = data.messages;

  console.log(`Loaded ${allMessages.length} messages from dataset.`);
  
  const cache = loadCache();
  const reviewCache = loadReviewCache();

  if (messageId) {
    const existsInMessages = allMessages.some(m => m.message_id === messageId);
    if (!existsInMessages) {
      console.error(`Error: Requested message ${messageId} not found in messages.csv.`);
      process.exit(1);
    }
    if (!cache[messageId]) {
      console.error(`Error: Requested message ${messageId} not found in predictions_cache.json.`);
      process.exit(1);
    }
  }

  // Metrics
  let totalPredictions = allMessages.length;
  let eligibleCount = 0;
  let skippedCount = 0; // Did not meet needsReview gate OR already processed
  let reviewerApproved = 0;
  let reviewerChallenged = 0;
  let reviewerFailed = 0;
  let judgeInvoked = 0;
  let judgeChangedDecision = 0;
  let judgeKeptRouter = 0;
  let judgeFailed = 0;
  let finalRouterSource = 0;
  let finalJudgeSource = 0;

  // Filter messages to process
  let toProcess: IncomingMessage[] = [];
  
  for (const msg of allMessages) {
    const msgId = msg.message_id;
    let cachedPred = cache[msgId];
    
    const ctx = buildMessageContext(msg, data);
    const safety = evaluateSafety(ctx);

    if (!cachedPred) {
      if (reviewStats) {
        console.warn(`Warning: No router prediction found for ${msgId}. Cannot calculate stats.`);
        continue;
      }
      
      console.log(`\n--- Routing ${msgId} ---`);
      const evidence = retrieveEvidence(ctx, data);
      const media = await processMedia(ctx, data);
      const routerDecision = await routeMessage(ctx, safety, evidence, media);
      
      if (isRoutingFailure(routerDecision)) {
        console.error(`  ❌ Router FAILED: ${routerDecision.error}`);
        continue;
      }
      
      cache[msgId] = {
        prediction: routerDecision,
        timestamp: new Date().toISOString()
      };
      saveCache(cache);
      cachedPred = cache[msgId];
    }
    
    let isEligible = false;
    
    if (messageId) {
      isEligible = (msgId === messageId);
    } else if (needsReview(ctx, safety, cachedPred.prediction)) {
      isEligible = true;
    }

    if (!isEligible) {
      if (!messageId) skippedCount++; // Only count skipped if we aren't targeting a specific message
      continue;
    }

    eligibleCount++;

    if (reviewCache[msgId]) {
      // Already fully reviewed and cached
      const rc = reviewCache[msgId];
      if (rc.reviewerVerdict.verdict === "approve") {
        reviewerApproved++;
      } else {
        reviewerChallenged++;
        judgeInvoked++;
        if (rc.judgeDecision) {
           // We have a successful judge decision cached
           if (rc.judgeDecision.action === cachedPred.prediction.action && rc.judgeDecision.message_type === cachedPred.prediction.message_type) {
             judgeKeptRouter++;
           } else {
             judgeChangedDecision++;
           }
        } else {
           judgeFailed++; // cached a challenge but no judge decision? This means judge failed originally.
        }
      }
      continue; // Skip running it again
    }

    toProcess.push(msg);
  }

  // Limit processing
  if (limit !== Infinity && toProcess.length > limit) {
    toProcess = toProcess.slice(0, limit);
  }

  console.log(`\nWill process ${toProcess.length} uncached eligible review(s).`);
  
  if (!reviewStats) {
    for (const msg of toProcess) {
      const msgId = msg.message_id;
      console.log(`\n--- Reviewing ${msgId} ---`);
      
      const cachedPred = cache[msgId];
      const ctx = buildMessageContext(msg, data);
    const safety = evaluateSafety(ctx);
    const evidence = retrieveEvidence(ctx, data);
    const media = await processMedia(ctx, data);
    
    if (messageId) {
      console.log(`Requested message: ${messageId}`);
    }
    console.log(`Selected message: ${msgId}`);
    
    console.log(`  Invoking Reviewer...`);
    const reviewerResult = await reviewMessage(ctx, safety, evidence, media, cachedPred.prediction);

    if (isReviewerFailure(reviewerResult)) {
      console.error(`  ❌ Reviewer FAILED: ${reviewerResult.error}`);
      reviewerFailed++;
      continue;
    }

    if (reviewerResult.verdict === "approve") {
      console.log(`  ✅ Reviewer Approved: ${reviewerResult.critique}`);
      reviewerApproved++;
      reviewCache[msgId] = {
        reviewerVerdict: reviewerResult,
        timestamp: new Date().toISOString()
      };
      saveReviewCache(reviewCache);
    } else {
      console.log(`  ⚠️ Reviewer Challenged: ${reviewerResult.critique}`);
      reviewerChallenged++;
      judgeInvoked++;

      console.log(`  Invoking Judge...`);
      const judgeResult = await judgeMessage(ctx, safety, evidence, media, cachedPred.prediction, reviewerResult);
      
      if (isRoutingFailure(judgeResult)) {
        console.error(`  ❌ Judge FAILED: ${judgeResult.error}`);
        judgeFailed++;
        // We still cache the reviewer challenge so we don't re-run reviewer, 
        // but we don't have a judgeDecision.
        reviewCache[msgId] = {
          reviewerVerdict: reviewerResult,
          timestamp: new Date().toISOString()
        };
        saveReviewCache(reviewCache);
        continue;
      }

      console.log(`  ⚖️ Judge Decision: action=${judgeResult.action}, type=${judgeResult.message_type}, conf=${judgeResult.confidence}`);
      
      if (judgeResult.action === cachedPred.prediction.action && judgeResult.message_type === cachedPred.prediction.message_type) {
        judgeKeptRouter++;
      } else {
        judgeChangedDecision++;
      }

      reviewCache[msgId] = {
        reviewerVerdict: reviewerResult,
        judgeDecision: judgeResult,
        timestamp: new Date().toISOString()
      };
      saveReviewCache(reviewCache);

      // Overwrite primary prediction
      cache[msgId].prediction = judgeResult;
      cache[msgId].timestamp = new Date().toISOString();
      saveCache(cache);
    }
    }
  }

  // Calculate Final Sources
  for (const msg of allMessages) {
    const rc = reviewCache[msg.message_id];
    if (rc && rc.judgeDecision) {
      finalJudgeSource++;
    } else {
      finalRouterSource++;
    }
  }

  console.log(`\n=== Final Counts ===`);
  console.log(`Total Predictions: ${totalPredictions}`);
  console.log(`Eligible: ${eligibleCount}`);
  console.log(`Skipped (Gate/Cached): ${skippedCount}`);
  console.log(`Reviewer Approved: ${reviewerApproved}`);
  console.log(`Reviewer Challenged: ${reviewerChallenged}`);
  console.log(`Reviewer Failed: ${reviewerFailed}`);
  console.log(`Judge Invoked: ${judgeInvoked}`);
  console.log(`Judge Changed Decision: ${judgeChangedDecision}`);
  console.log(`Judge Kept Router: ${judgeKeptRouter}`);
  console.log(`Judge Failed: ${judgeFailed}`);
  console.log(`Final Router Source: ${finalRouterSource}`);
  console.log(`Final Judge Source: ${finalJudgeSource}`);

  if (!reviewStats) {
    generateOutputCsv(allMessages, cache);
  } else {
    console.log(`\nReview stats calculated (dry run). No changes made.`);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
