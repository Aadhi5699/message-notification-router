import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import audioDecode from 'audio-decode';
import pkg from 'wavefile';
const { WaveFile } = pkg;

async function test() {
  try {
    const filePath = path.resolve('../dataset/media/audio/vn_001.mp3');
    const buffer = fs.readFileSync(filePath);
    
    // Decode the mp3 to PCM
    const decoded = await audioDecode(buffer);
    
    // Get channel data
    const float32Array = decoded.channelData[0];
    
    // We must resample to 16kHz
    const wav = new WaveFile();
    // Create a 32-bit float WAV file from the decoded audio
    wav.fromScratch(1, decoded.sampleRate, '32f', float32Array);
    
    // Resample to 16kHz
    wav.toSampleRate(16000);
    
    // Get the resampled Float32Array
    const audioData = wav.getSamples();
    
    console.log("Audio prepared, loading model...");
    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    
    console.log("Transcribing...");
    const out = await transcriber(audioData);
    
    console.log("Result:", out);
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
