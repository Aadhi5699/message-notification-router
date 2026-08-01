/**
 * multimodal.ts — Resolves media file paths for the incoming message.
 *
 * Image files:
 *   Resolves the absolute path from images.csv metadata.
 *   The Claude Agent SDK's built-in Read tool will read the image natively
 *   (including Base64/MIME handling). We do NOT manually encode here.
 *
 * Voice notes:
 *   Resolves the absolute path. Transcription is intentionally skipped.
 *   The interface is extensible so local Whisper transcription can be added
 *   later without changing the Router contract.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { MessageContext } from "./types.js";
import type { DataStore } from "./data-loader.js";

// ---------------------------------------------------------------------------
// ProcessedMedia — what the router receives
// ---------------------------------------------------------------------------

export interface ProcessedMedia {
  type: "image" | "voice" | "none";

  /** Absolute file path for the image (SDK's Read tool will read it). */
  filePath?: string;

  /** Voice note transcription status. */
  voiceStatus?: string;

  /** Absolute file path for the voice note (for future transcription). */
  voicePath?: string;
}

// ---------------------------------------------------------------------------
// processMedia — resolves paths, does NOT load file contents
// ---------------------------------------------------------------------------

/**
 * Resolves media attached to the incoming message.
 *
 * For images: returns the absolute path so the router prompt can instruct
 * the Claude Agent SDK to read the image via its built-in Read tool.
 *
 * For voice notes: returns the path and a "transcription_skipped" status.
 */
export function processMedia(ctx: MessageContext, data: DataStore): ProcessedMedia {
  const { media_type, media_id } = ctx.message;

  if (media_type === "image" && media_id) {
    const imageRecord = data.imageMap.get(media_id);
    if (imageRecord) {
      const fullPath = resolve(data.datasetDir, imageRecord.file_path);
      if (existsSync(fullPath)) {
        return { type: "image", filePath: fullPath };
      }
      console.warn(`[multimodal] Image file not found at ${fullPath}`);
    }
  }

  if (media_type === "voice" && media_id) {
    const voiceRecord = data.voiceNoteMap.get(media_id);
    if (voiceRecord) {
      const fullPath = resolve(data.datasetDir, voiceRecord.file_path);
      return {
        type: "voice",
        voicePath: fullPath,
        voiceStatus: "transcription_skipped",
      };
    }
  }

  return { type: "none" };
}
