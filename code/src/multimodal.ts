import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pipeline } from "@xenova/transformers";
import audioDecode from "audio-decode";
import pkg from "wavefile";
const { WaveFile } = pkg;
import type { MessageContext } from "./types.js";
import type { DataStore } from "./data-loader.js";

// Lazy-loaded transcriber instance
let transcriber: any = null;

async function getTranscriber() {
  if (!transcriber) {
    console.log("Loading Whisper model...");
    transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
  }
  return transcriber;
}

export interface ProcessedMedia {
  type: "image" | "voice" | "none";
  filePath?: string;
  voiceTranscript?: string;
  voicePath?: string;
}

export async function processMedia(ctx: MessageContext, data: DataStore): Promise<ProcessedMedia> {
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
      if (existsSync(fullPath)) {
        console.log(`Transcribing voice note: ${media_id}`);
        try {
          const buffer = readFileSync(fullPath);
          const decoded = await audioDecode(buffer);
          const float32Array = decoded.channelData[0];
          
          const wav = new WaveFile();
          wav.fromScratch(1, decoded.sampleRate, "32f", float32Array);
          wav.toSampleRate(16000);
          const audioData = wav.getSamples();
          
          const t = await getTranscriber();
          const out = await t(audioData);
          
          return {
            type: "voice",
            voicePath: fullPath,
            voiceTranscript: out.text.trim()
          };
        } catch (err) {
          console.error(`[multimodal] Error transcribing voice note ${fullPath}:`, err);
          return { type: "voice", voicePath: fullPath, voiceTranscript: "<TRANSCRIPTION FAILED>" };
        }
      } else {
        console.warn(`[multimodal] Voice file not found at ${fullPath}`);
      }
    }
  }

  return { type: "none" };
}
