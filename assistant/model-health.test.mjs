import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLocalModel } from './model-health.mjs';
import { createPilotServer } from './server.mjs';

const model = 'qwen3.8:27b';
const tagsUrl = 'http://127.0.0.1:11435/api/tags';
const installed = () => Response.json({ models: [{ name: model }] });

test('readiness checks the exact installed model without running inference', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, 'error');
    return installed();
  });
  assert.equal((await probeLocalModel({ model })).available, true);
  assert.deepEqual(calls, [tagsUrl]);
});

test('another installed Qwen model does not count as the configured model', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [{ name: 'qwen3:32b' }] }));
  const result = await probeLocalModel({ model });
  assert.equal(result.available, false);
  assert.equal(result.status, 'model-missing');
  assert.match(result.message, /qwen3\.8:27b is not installed/);
});

test('unreachable Ollama has a useful message without exposing raw errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('PRIVATE_INTERNAL_ERROR'); });
  const result = await probeLocalModel({ model });
  assert.equal(result.status, 'unreachable');
  assert.match(result.message, /not reachable/);
  assert.doesNotMatch(result.message, /PRIVATE/);
});

test('a stalled readiness request is aborted within its deadline', { timeout: 1000 }, async t => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  const result = await probeLocalModel({ model, timeoutMs: 20 });
  assert.equal(result.status, 'timeout');
  assert.equal(aborted, true);
});

test('readiness rejects remote endpoints without fetching them', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  const result = await probeLocalModel({ model, baseUrl: 'https://example.com' });
  assert.equal(result.status, 'invalid-configuration');
  assert.equal(mocked.mock.calls.length, 0);
});

test('invalid and oversized model lists cannot report available', async t => {
  const responses = [new Response('PRIVATE_INVALID_JSON'), Response.json({ unexpected: [] }), new Response('x'.repeat(65537))];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let index = 0; index < 3; index += 1) {
    const result = await probeLocalModel({ model });
    assert.equal(result.status, 'invalid-response');
    assert.equal(result.available, false);
    assert.doesNotMatch(result.message, /PRIVATE/);
  }
});

async function startServer(t) {
  const server = createPilotServer({ localModel: model, analystMode: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP health distinguishes backend access from model availability', async t => {
  const base = await startServer(t);
  const originalFetch = globalThis.fetch;
  let available = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === tagsUrl) return available ? installed() : Response.json({ models: [] });
    return originalFetch(url, options);
  });
  const ready = await fetch(base + '/api/health').then(response => response.json());
  assert.equal(ready.status, 'ok');
  assert.equal(ready.modelHealth.available, true);
  available = false;
  const missing = await fetch(base + '/api/health').then(response => response.json());
  assert.equal(missing.status, 'degraded');
  assert.equal(missing.model, model);
  assert.equal(missing.modelHealth.status, 'model-missing');
});

test('failed analyst requests identify a missing model without extra inference', async t => {
  const base = await startServer(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith(base)) return originalFetch(url, options);
    calls.push(String(url));
    if (String(url) === tagsUrl) return Response.json({ models: [] });
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    return Response.json({ error: 'model not found' }, { status: 404 });
  });
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'top goal scorer', context: { seasons: ['2025-2026'], competition: '1', team: 'all' } }) });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.modelHealth.status, 'model-missing');
  assert.match(result.error, /qwen3\.8:27b is not installed/);
  assert.deepEqual(calls, ['http://127.0.0.1:11435/api/chat', tagsUrl]);
});
