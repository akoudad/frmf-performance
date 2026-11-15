import { spawn } from 'node:child_process';
import { loadConfiguration } from './configuration.mjs';

try {
  loadConfiguration();
  const url = new URL(process.env.FRMF_MODEL_BASE_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use a local HTTP loopback address in FRMF_MODEL_BASE_URL to start Ollama.');
  }
  const child = spawn(process.env.FRMF_OLLAMA_BIN || 'ollama', ['serve'], {
    stdio: 'inherit',
    env: { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || '80'}`, OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_KEEP_ALIVE: '10m' },
  });
  child.on('error', error => {
    console.error(error.code === 'ENOENT' ? 'Ollama is not installed or FRMF_OLLAMA_BIN is incorrect.' : `Ollama could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => { process.exitCode = code !== null && code >= 0 ? code : signal === 'SIGINT' ? 130 : 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) {
  console.error(`Ollama could not start: ${error.message}`);
  process.exitCode = 1;
}
