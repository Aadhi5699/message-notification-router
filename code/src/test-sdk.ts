import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';

async function run() {
  try {
    const res = await query({ prompt: 'Respond with exactly: {"status":"ok"}' });
    console.log('RES:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('ERR:', e);
  }
}

run();
