import { pipeline } from '@xenova/transformers';
import path from 'path';

async function test() {
  try {
    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    const out = await transcriber(path.resolve('../../dataset/media/audio/vn_001.mp3'));
    console.log("Success:", out);
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
