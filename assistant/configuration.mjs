import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function loadConfiguration() {
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The project .env file could not be read.', { cause: error }); }
  process.env.FRMF_LOCAL_MODEL ||= 'qwen3.8:27b';
  process.env.FRMF_MODEL_BASE_URL ||= 'http://127.0.0.1:11435';
}
