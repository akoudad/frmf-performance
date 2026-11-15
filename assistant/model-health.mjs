/** Check runtime connectivity and model installation without running inference. */
export async function probeLocalModel({ model, baseUrl, timeoutMs = 2000 } = {}) {
  const failure = (status, message) => ({ available: false, status, message });
  let url;
  try {
    url = new URL(baseUrl || (model === 'qwen3.8:27b' ? 'http://127.0.0.1:11435' : 'http://127.0.0.1:11434'));
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid endpoint');
  } catch {
    return failure('invalid-configuration', 'The local AI service address is invalid. Configure a local Ollama address.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(new URL('/api/tags', url), { redirect: 'error', signal: controller.signal });
    if (!response.ok) return failure('unavailable', 'The local AI service (Ollama) is unavailable. Check the service and retry.');
    reader = response.body?.getReader();
    if (!reader) return failure('invalid-response', 'The local AI service returned an unreadable model list. Check Ollama and retry.');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        controller.abort();
        return failure('invalid-response', 'The local AI service returned an oversized model list. Check Ollama and retry.');
      }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.models)) return failure('invalid-response', 'The local AI service returned an unreadable model list. Check Ollama and retry.');
    if (!data.models.some(entry => entry?.name === model || entry?.model === model)) {
      return failure('model-missing', `The configured local model ${model} is not installed in the connected Ollama service.`);
    }
    return { available: true, status: 'available', message: 'The local AI service is reachable and the configured model is installed.' };
  } catch (error) {
    if (controller.signal.aborted) return failure('timeout', 'The local AI service (Ollama) did not respond in time. Check the service and retry.');
    if (error instanceof SyntaxError) return failure('invalid-response', 'The local AI service returned an unreadable model list. Check Ollama and retry.');
    return failure('unreachable', 'The local AI service (Ollama) is not reachable. Start it and retry.');
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch { /* The stream may already be closed or aborted. */ } }
  }
}
