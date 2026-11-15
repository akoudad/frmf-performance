import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatResponse } from './public/progress-state.mjs';

const encoded = value => new TextEncoder().encode(value);
const streamed = chunks => new Response(new ReadableStream({
  start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); },
}), { headers: { 'Content-Type': 'application/x-ndjson' } });

test('stream parser delivers real stages and preserves split UTF-8 result rows', async () => {
  const events = [
    ...['refreshing', 'interpreting', 'checking', 'calculating', 'querying', 'reviewing', 'composing'].map(stage => ({ type: 'progress', stage })),
    { type: 'result', data: { answer: 'Résultats', rows: [{ player: 'Zineb Bennani' }] } },
  ];
  const bytes = encoded(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const stages = [];
  const data = await readChatResponse(streamed([...bytes].map(byte => Uint8Array.of(byte))), stage => stages.push(stage));
  assert.deepEqual(stages, ['refreshing', 'interpreting', 'checking', 'calculating', 'querying', 'reviewing', 'composing']);
  assert.deepEqual(data, events.at(-1).data);
});

test('unfamiliar well-formed stages preserve the final result and service error', async () => {
  const stages = [];
  const events = [{ type: 'progress', stage: 'future_stage' }, { type: 'progress', stage: 'checking' },
    { type: 'progress', stage: 'x'.repeat(64) }, { type: 'result', data: { answer: 'Ready', rows: [] } }];
  const data = await readChatResponse(streamed([encoded(events.map(event => JSON.stringify(event)).join('\n'))]), stage => stages.push(stage));
  assert.deepEqual(stages, ['checking']);
  assert.deepEqual(data, events.at(-1).data);
  await assert.rejects(readChatResponse(streamed([encoded('{"type":"progress","stage":"future_stage"}\n{"type":"error","data":{"error":"Model timed out"}}\n')])), /Model timed out/);
});

test('stream and JSON errors remain visible instead of producing empty successes', async () => {
  await assert.rejects(readChatResponse(streamed([encoded('{"type":"progress","stage":"interpreting"}\n{"type":"error","data":{"error":"Model timed out"}}\n')])), /Model timed out/);
  await assert.rejects(readChatResponse(new Response('{"error":"Busy"}', { status: 429 })), /Busy/);
  assert.deepEqual(await readChatResponse(new Response('{"answer":"Ready","rows":[]}')), { answer: 'Ready', rows: [] });
});

test('truncated, malformed, oversized and invalid progress cannot become an answer', async () => {
  for (const [text, reason] of [
    ['{"type":"progress","stage":"interpreting"}\n', /before an answer/],
    ['{"type":', /interrupted/],
    ['{"type":"result","data":{}}\n{"type":"result","data":{}}', /after completing/],
    ['x'.repeat(1024 * 1024 + 1), /display limit/],
  ]) await assert.rejects(readChatResponse(streamed([encoded(text)])), reason);
});

test('malformed stages and terminal events remain invalid', async () => {
  const invalid = [
    ...[undefined, null, 1, {}, [], '', 'UPPERCASE', 'bad stage', 'x'.repeat(65)].map(stage => ({ type: 'progress', stage })),
    null, [], { type: 'unknown' },
    ...[undefined, null, [], 'Ready'].map(data => ({ type: 'result', data })),
    ...[undefined, null, [], {}, { error: '' }, { error: ' ' }, { error: 1 }].map(data => ({ type: 'error', data })),
  ];
  for (const event of invalid) {
    await assert.rejects(readChatResponse(streamed([encoded(JSON.stringify(event) + '\n')])), /unreadable progress/);
  }
});

test('cancelling a response releases the reader and cannot return a completed answer', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('Cancelled', 'AbortError')); } }),
    { headers: { 'Content-Type': 'application/x-ndjson' } });
  await assert.rejects(readChatResponse(response), { name: 'AbortError' });
  assert.equal(response.body.locked, false);
});
