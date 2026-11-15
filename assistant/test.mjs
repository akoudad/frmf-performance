import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, catalog, executePlan, InputError } from './engine.mjs';
import { createPilotServer } from './server.mjs';
import { createScopeRequests } from './public/scope-state.mjs';

const context = { season: '2025-2026', competition: 'Botola Pro D1' };

test('Omar Housni reproduces the saved Power BI player totals including assists', () => {
  const result = chat({ question: 'Show Omar Housni totals', context });
  assert.equal(result.rows[0].appearances, 23);
  assert.equal(result.rows[0].goals, 4);
  assert.equal(result.rows[0].assists, 8);
  assert.equal(result.rows[0].yellowCards, 7);
  assert.equal(result.rows[0].redCards, 0);
  assert.equal(result.evidence.matchCount, 23);
  assert.equal(result.mode, 'deterministic-demo');
});

test('Hassania team totals agree with the independently saved BI view', () => {
  const result = chat({ question: 'Show Hassania Agadir team totals', context });
  assert.deepEqual(result.rows[0], { team: 'Hassania Agadir', played: 30, goalsFor: 42, assists: 23, goalsAgainst: 29, wins: 13, draws: 8, losses: 9, winRate: '43.3%' });
});

test('Competition goal leaderboard matches the saved 2025–2026 screenshot', () => {
  const result = chat({ question: 'Show top scorers', context });
  assert.equal(result.rows[0].player, 'Mohamed Qadiri');
  assert.equal(result.rows[0].goals, 12);
  assert.equal(result.rows[1].player, 'Driss Benbrahim');
  assert.equal(result.rows[1].goals, 11);
  assert.equal(result.evidence.matchCount, 240);
});

test('Assist ranking is sorted, source-linked and supports a club filter', () => {
  const result = chat({ question: 'Show top assist providers', context: { ...context, team: 'Hassania Agadir' } });
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every(row => row.club === 'Hassania Agadir'));
  assert.ok(result.rows.every((row, i) => !i || row.assists <= result.rows[i - 1].assists));
  assert.equal(result.evidence.matchCount, 30);
});

test('Women U19 catalog excludes male senior players and only includes appearances', () => {
  const result = catalog({ season: '2025-2026', competition: 'U19 Women' });
  assert.ok(result.players.length > 0);
  assert.equal(result.players.some(row => row.name === 'Omar Housni'), false);
  assert.ok(result.teams.every(row => row.name.includes('Women U19')));
  const noAppearance = chat({ question: 'Show Omar Housni totals', context: { season: '2025-2026', competition: 'U19 Women' } });
  assert.deepEqual(noAppearance.rows, []);
  assert.match(noAppearance.answer, /no recorded appearance/);
});

test('Ambiguous, unsupported and conflicting requests do not silently broaden scope', () => {
  assert.deepEqual(chat({ question: 'Why will Raja win next year?', context }).rows, []);
  const changed = chat({ question: 'Show Wydad Casablanca totals', context: { ...context, team: 'Raja Casablanca' } });
  assert.match(changed.answer, /selected team.*question names/);
  const plan = executePlan({ operation: 'player_totals', player: 'Omar Housni', competition: 'Championnat Féminin D1' }, { question: 'Show totals', context });
  assert.deepEqual(plan.rows, []);
  assert.match(plan.answer, /different competition/);
  assert.throws(() => executePlan({ operation: 'sql', query: 'SELECT *' }, { question: 'Show totals', context }), InputError);
});

test('Approved model plan uses the same verified engine', () => {
  const result = executePlan({ operation: 'player_totals', player: 'Omar Housni' }, { question: 'How productive was Omar Housni?', context });
  assert.equal(result.rows[0].assists, 8);
});

test('HTTP endpoints reject invalid bodies and origins; opaque PBI origin can preflight', async t => {
  const server = createPilotServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(base + '/api/health').then(r => r.json());
  assert.deepEqual(health, { status: 'ok', mode: 'synthetic-demo', model: 'none', server: 'Mac pilot' });
  const preflight = await fetch(base + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const invalid = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalid.status, 400);
  const wrongOrigin = await fetch(base + '/api/health', { headers: { Origin: 'https://example.com' } });
  assert.equal(wrongOrigin.status, 403);
  const oversized = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'a'.repeat(9000) }) });
  assert.equal(oversized.status, 413);
  const result = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.powerbi.com' }, body: JSON.stringify({ question: 'Show Omar Housni totals', context }) }).then(r => r.json());
  assert.equal(result.rows[0].assists, 8);
  const browserModule = await fetch(base + '/scope-state.mjs');
  assert.equal(browserModule.status, 200);
  assert.match(browserModule.headers.get('content-type'), /javascript/);
  assert.match(await browserModule.text(), /export function createScopeRequests/);
  const progressModule = await fetch(base + '/progress-state.mjs');
  assert.equal(progressModule.status, 200);
  assert.match(progressModule.headers.get('content-type'), /javascript/);
  assert.match(await progressModule.text(), /export async function readChatResponse/);
});

test('opt-in request diagnostics record arrival without query, header or body contents', async t => {
  const entries = [];
  t.mock.method(console, 'log', value => entries.push(JSON.parse(value)));
  const server = createPilotServer({ requestDiagnostics: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(base + '/api/health?player=PRIVATE_NAME', { method: 'OPTIONS', headers: { Origin: 'null' } });
  await fetch(base + '/PRIVATE_NAME?secret=PRIVATE_SECRET');
  await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Secret': 'PRIVATE_HEADER' }, body: JSON.stringify({ question: 'PRIVATE_QUESTION' }) });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].method, 'OPTIONS');
  assert.equal(entries[0].pathname, '/api/health');
  assert.equal(entries[1].pathname, '[unrecognized-path]');
  assert.equal(entries[2].pathname, '/api/chat');
  assert.ok(entries.every(entry => Object.keys(entry).sort().join(',') === 'method,pathname,timestamp'));
  assert.ok(entries.every(entry => !Number.isNaN(Date.parse(entry.timestamp))));
  assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
});

test('disconnecting a question cancels local inference and releases the next request', { timeout: 10000 }, async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new AbortController();
  let releasePending;
  t.after(() => {
    client.abort();
    releasePending?.();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const bounded = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The cancellation handshake did not finish.')), 3000);
      })]);
    } finally { clearTimeout(timer); }
  };
  let markStarted; let markAborted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const aborted = new Promise(resolve => { markAborted = resolve; });
  let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith(`${base}/`)) return originalFetch(url, options);
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen3.8:27b');
    assert.deepEqual(JSON.parse(body.messages[1].content).context, context);
    modelCalls += 1;
    if (modelCalls === 1) {
      return new Promise((_, reject) => {
        releasePending = () => reject(new DOMException('Test cleanup', 'AbortError'));
        options.signal.addEventListener('abort', () => {
          markAborted();
          reject(options.signal.reason);
        }, { once: true });
        markStarted();
      });
    }
    return new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
      operation: 'player_totals', metric: 'assists', player: 'Omar Housni', team: '', season: '', competition: '',
    }) } }));
  });
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  assert.equal(health.model, 'qwen3.8:27b');
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'How many assists did Omar Housni make?', context }) };
  const pending = fetch(`${base}/api/chat`, { ...request, signal: client.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await bounded(started);
  const busy = await fetch(`${base}/api/chat`, request);
  assert.equal(busy.status, 429);
  await busy.json();
  assert.equal(modelCalls, 1);
  client.abort();
  await bounded(Promise.all([rejected, aborted]));
  const next = await fetch(`${base}/api/chat`, request);
  assert.equal(next.status, 200);
  const answer = await next.json();
  assert.equal(answer.model, 'qwen3.8:27b');
  assert.equal(answer.rows[0].assists, 8);
  assert.equal(answer.evidence.scope.competition, context.competition);
  assert.equal(modelCalls, 2);
});

test('a ranking clarification reuses the validated plan and rejects changed or replayed requests', async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { question: 'Find players with high rates of both goals and assists, minimum 15 appearances.', context };
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    assert.equal(JSON.parse(options.body).model, 'qwen3.8:27b');
    return new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
      operation: 'leaderboard', metric: 'goalContributions', basis: 'clarify', minimumAppearances: 15, requireBoth: true,
      player: '', team: '', season: '', competition: '',
    }) } }));
  });
  const post = async value => {
    const result = await originalFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { status: result.status, data: await result.json() };
  };
  const first = await post(body);
  assert.equal(first.status, 200);
  assert.equal(first.data.clarification.field, 'rankingBasis');
  const token = first.data.clarification.token;
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(mock.mock.callCount(), 1);
  const followup = { ...body, rankingBasis: 'perAppearance', clarificationToken: token };
  for (const invalid of [
    { ...followup, context: { ...context, competition: 'Coupe du Trône' } },
    { ...followup, question: 'Show top scorers' },
    { ...followup, rankingBasis: undefined },
    ...[null, {}, 1, '', 'x'.repeat(37), '00000000-0000-0000-0000-000000000000'].map(clarificationToken => ({ ...followup, clarificationToken })),
  ]) {
    const rejected = await post(invalid);
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /resubmit the question/);
    assert.equal(mock.mock.callCount(), 1);
  }
  const resolved = await post({ ...followup, context: { competition: context.competition, season: context.season } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.clarificationResolved, true);
  assert.equal(resolved.data.mode, 'local-model-demo');
  assert.equal(resolved.data.model, 'qwen3.8:27b');
  assert.equal(resolved.data.evidence.ranking.metric, 'goalContributions');
  assert.equal(resolved.data.evidence.ranking.basis, 'perAppearance');
  assert.equal(resolved.data.evidence.ranking.minimumAppearances, 15);
  assert.equal(resolved.data.evidence.ranking.requireBoth, true);
  assert.ok(resolved.data.rows.length > 0);
  assert.ok(resolved.data.rows.every(row => row.goals > 0 && row.assists > 0 && row.appearances >= 15));
  assert.equal(mock.mock.callCount(), 1);
  const replay = await post(followup);
  assert.equal(replay.status, 400);
  assert.match(replay.data.error, /resubmit the question/);
  assert.equal(mock.mock.callCount(), 1);
});

test('pending ranking clarifications expire and retain at most 32 choices', async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { question: 'Find players with high rates of both goals and assists', context };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const mock = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    return new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
      operation: 'leaderboard', metric: 'goalContributions', basis: 'clarify', minimumAppearances: 0, requireBoth: true,
      player: '', team: '', season: '', competition: '',
    }) } }));
  });
  const post = async value => {
    const result = await originalFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { status: result.status, data: await result.json() };
  };
  const tokens = [];
  for (let index = 0; index < 33; index += 1) {
    const answer = await post(body);
    assert.equal(answer.status, 200);
    tokens.push(answer.data.clarification.token);
  }
  assert.equal(new Set(tokens).size, 33);
  const oldest = await post({ ...body, rankingBasis: 'total', clarificationToken: tokens[0] });
  assert.equal(oldest.status, 400);
  assert.match(oldest.data.error, /resubmit the question/);
  const retained = await post({ ...body, rankingBasis: 'total', clarificationToken: tokens[1] });
  assert.equal(retained.status, 200);
  assert.equal(retained.data.clarificationResolved, true);
  now += 5 * 60 * 1000;
  const expired = await post({ ...body, rankingBasis: 'total', clarificationToken: tokens.at(-1) });
  assert.equal(expired.status, 400);
  assert.match(expired.data.error, /resubmit the question/);
  assert.equal(mock.mock.callCount(), 33);
});

test('streamed progress arrives before inference finishes and preserves the JSON result', { timeout: 10000 }, async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let finishModel;
  t.after(() => {
    finishModel?.();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const modelResponse = () => new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
    operation: 'player_totals', metric: 'assists', player: 'Omar Housni', team: '', season: '', competition: '',
  }) } }));
  let modelCalls = 0; let modelFinished = false;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    modelCalls += 1;
    if (modelCalls === 1) return new Promise(resolve => { finishModel = () => { modelFinished = true; resolve(modelResponse()); }; });
    return modelResponse();
  });
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ question: 'How many assists did Omar Housni make?', context }) };
  const response = await originalFetch(`${base}/api/chat`, request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const first = await reader.read();
  let text = new TextDecoder().decode(first.value);
  assert.deepEqual(JSON.parse(text.trim()), { type: 'progress', stage: 'interpreting' });
  assert.equal(modelFinished, false);
  const busy = await originalFetch(`${base}/api/chat`, request);
  assert.equal(busy.status, 429);
  assert.match(busy.headers.get('content-type'), /application\/json/);
  assert.match((await busy.json()).error, /another request/);
  finishModel();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type === 'progress' ? event.stage : event.type), ['interpreting', 'checking', 'calculating', 'result']);
  assert.ok(events.filter(event => event.type === 'progress').every(event => Object.keys(event).sort().join(',') === 'stage,type'));
  const jsonResponse = await originalFetch(`${base}/api/chat`, { ...request, headers: { 'Content-Type': 'application/json' } });
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get('content-type'), /application\/json/);
  const { latencyMs: streamedLatency, ...streamed } = events.at(-1).data;
  const { latencyMs: jsonLatency, ...ordinary } = await jsonResponse.json();
  assert.equal(typeof streamedLatency, 'number');
  assert.equal(typeof jsonLatency, 'number');
  assert.deepEqual(streamed, ordinary);
  assert.equal(streamed.rows[0].assists, 8);
});

test('streamed failures end with an error event while validation failures stay HTTP JSON', async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mock = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    return new Response('Model not available', { status: 503 });
  });
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ question: 'Show Omar Housni totals', context }) };
  const invalid = await originalFetch(`${base}/api/chat`, { ...request, body: JSON.stringify({ question: '' }) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get('content-type'), /application\/json/);
  assert.match((await invalid.json()).error, /question/);
  assert.equal(mock.mock.callCount(), 0);
  for (let index = 0; index < 2; index += 1) {
    const response = await originalFetch(`${base}/api/chat`, request);
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ['progress', 'error']);
    assert.equal(events[0].stage, 'interpreting');
    assert.equal(events[1].data.model, 'qwen3.8:27b');
    assert.equal(events[1].data.plannerStatus, 'unavailable');
    assert.match(events[1].data.error, /HTTP 503/);
  }
  assert.equal(mock.mock.callCount(), 2);
});

test('aborting a streamed request cancels inference and leaves the next request available', { timeout: 10000 }, async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  let releasePending;
  t.after(() => {
    controller.abort(); releasePending?.(); server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let markAborted;
  const aborted = new Promise(resolve => { markAborted = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    calls += 1;
    if (calls === 1) return new Promise((_, reject) => {
      releasePending = () => reject(new DOMException('Test cleanup', 'AbortError'));
      options.signal.addEventListener('abort', () => { markAborted(); reject(options.signal.reason); }, { once: true });
    });
    return new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
      operation: 'player_totals', metric: 'assists', player: 'Omar Housni', team: '', season: '', competition: '',
    }) } }));
  });
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ question: 'Show Omar Housni totals', context }) };
  const response = await originalFetch(`${base}/api/chat`, { ...request, signal: controller.signal });
  const reader = response.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).stage, 'interpreting');
  const stopped = assert.rejects(reader.read(), { name: 'AbortError' });
  controller.abort();
  await Promise.all([stopped, aborted]);
  const next = await originalFetch(`${base}/api/chat`, request);
  assert.equal(next.status, 200);
  const events = (await next.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).data.rows[0].assists, 8);
  assert.equal(calls, 2);
});

test('streamed clarification continuation checks and calculates without interpreting again', async t => {
  const originalFetch = globalThis.fetch;
  const server = createPilotServer({ localModel: 'qwen3.8:27b', modelBaseUrl: 'http://127.0.0.1:11435' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { question: 'Find players with high rates of goals and assists', context };
  const mock = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    return new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, message: { content: JSON.stringify({
      operation: 'leaderboard', metric: 'goalContributions', basis: 'clarify', minimumAppearances: 0, requireBoth: true,
      player: '', team: '', season: '', competition: '',
    }) } }));
  });
  const post = value => originalFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(value) });
  const first = await post(body);
  const firstEvents = (await first.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(firstEvents.map(event => event.stage ?? event.type), ['interpreting', 'checking', 'result']);
  const token = firstEvents.at(-1).data.clarification.token;
  const followup = { ...body, rankingBasis: 'perAppearance', clarificationToken: token };
  const resolved = await post(followup);
  const events = (await resolved.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.stage ?? event.type), ['checking', 'calculating', 'result']);
  assert.equal(events.at(-1).data.clarificationResolved, true);
  assert.equal(events.at(-1).data.evidence.ranking.metric, 'goalContributions');
  assert.equal(events.at(-1).data.evidence.ranking.requireBoth, true);
  assert.equal(mock.mock.callCount(), 1);
  const replay = await post(followup);
  assert.equal(replay.status, 400);
  assert.match(replay.headers.get('content-type'), /application\/json/);
  assert.match((await replay.json()).error, /resubmit the question/);
});

test('a changed filter cancels the pending answer and prevents a late response from rendering', async () => {
  const requests = createScopeRequests();
  const old = requests.begin('answer');
  let complete;
  const lateResult = new Promise(resolve => { complete = resolve; });
  let shown = 'new selection is empty';
  const pendingRender = lateResult.then(answer => { if(old.isCurrent()) shown = answer; });
  requests.invalidate();
  assert.equal(old.signal.aborted, true);
  complete('old competition answer');
  await pendingRender;
  assert.equal(shown, 'new selection is empty');
  const current = requests.begin('answer');
  assert.equal(current.isCurrent(), true);
  assert.equal(old.isCurrent(), false);
});

test('out-of-order catalog responses cannot replace the most recent competition choices', async () => {
  const requests = createScopeRequests();
  const first = requests.begin('catalog');
  const second = requests.begin('catalog');
  let options = [];
  const receive = (token, values) => { if(token.isCurrent()) options = values; };
  receive(second, ['Women U19 club']);
  receive(first, ['Senior men club']);
  assert.deepEqual(options, ['Women U19 club']);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test('selection invalidation retires both catalog and answer requests, including stale finalizers', () => {
  const requests = createScopeRequests();
  const catalog = requests.begin('catalog');
  const answer = requests.begin('answer');
  requests.invalidate();
  const replacement = requests.begin('catalog');
  assert.equal(catalog.isCurrent(), false);
  assert.equal(answer.isCurrent(), false);
  assert.equal(replacement.isCurrent(), true);
  assert.equal(catalog.signal.aborted, true);
  assert.equal(answer.signal.aborted, true);
});
