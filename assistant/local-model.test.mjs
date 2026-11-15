import test from 'node:test';
import assert from 'node:assert/strict';
import { planQuestion } from './local-model.mjs';

const plan = values => ({ operation: 'player_totals', metric: 'assists', player: 'Omar Housni', team: '', season: '', competition: '', ...values });
const question = { question: 'How many assists did Omar Housni make?', context: { season: '2025-2026' } };
const mockResponse = (value, model = 'llama3.2:3b') => new Response(JSON.stringify({ model, done: true, message: { content: JSON.stringify(value) } }));

test('sends question and selected context only; returns no fabricated statistics', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'llama3.2:3b');
    assert.equal(body.stream, false);
    assert.equal(body.format.additionalProperties, false);
    assert.deepEqual(JSON.parse(body.messages[1].content), question);
    return mockResponse(plan({}));
  });
  const result = await planQuestion(question);
  assert.equal(result.status, 'planned');
  assert.equal(result.provider, 'ollama-local');
  assert.deepEqual(result.intent, { operation: 'player_totals', metric: 'assists', player: 'Omar Housni' });
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(result.answer, undefined);
});

test('rejects invalid input, external endpoints and unapproved models before network access', async t => {
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must not run.'); });
  for (const [body, options] of [
    [{ question: '' }, {}], [{ question: 'x'.repeat(1001) }, {}],
    [{ question: 'hi', context: { sql: 'SELECT *' } }, {}],
    [question, { baseUrl: 'https://example.com' }], [question, { baseUrl: 'http://127.0.0.1:11434/api/chat' }],
    [question, { baseUrl: 'http://user:password@localhost:11434' }],
    [question, { model: 'qwen3:32b-cloud' }], [question, { timeoutMs: 0 }],
    [question, { timeoutMs: 120001 }], [question, { signal: {} }],
    [{ ...question, rankingBasis: 'per90' }, {}],
  ]) assert.equal((await planQuestion(body, options)).status, 'invalid');
  assert.equal(mock.mock.callCount(), 0);
});

test('Qwen uses its isolated runtime, bounded loading time and instructed structured planning', async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 120000);
    return timeout(milliseconds);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11435/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen3.8:27b');
    assert.equal(body.think, false);
    assert.deepEqual(body.options, { temperature: 0, num_predict: 384, num_ctx: 4096 });
    assert.equal(body.format.additionalProperties, false);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /Never answer the question, invent statistics/);
    assert.deepEqual(JSON.parse(body.messages[1].content), question);
    return mockResponse(plan({}), 'qwen3.8:27b');
  });
  const result = await planQuestion(question, { model: 'qwen3.8:27b', baseUrl: undefined });
  assert.equal(result.status, 'planned');
  assert.equal(result.model, 'qwen3.8:27b');
  assert.equal(result.intent.player, 'Omar Housni');
});

test('combined rankings preserve both-stat criteria and a user clarification choice', async t => {
  const body = { question: 'Find players with high rates of both goals and assists', context: { season: '2025-2026' }, rankingBasis: 'perAppearance' };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(payload.messages[1].content), body);
    return mockResponse(plan({ operation: 'leaderboard', player: '', metric: 'goalContributions', basis: 'clarify', minimumAppearances: 0, requireBoth: true }));
  });
  const result = await planQuestion(body);
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.intent, { operation: 'leaderboard', metric: 'goalContributions', basis: 'perAppearance', minimumAppearances: 0, requireBoth: true });
});

test('ranking plans reject invented formulas, invalid denominators and qualification values', async t => {
  let value;
  t.mock.method(globalThis, 'fetch', async () => mockResponse(value));
  for (value of [plan({ metric: 'goals*assists' }), plan({ basis: 'per90' }), plan({ minimumAppearances: -1 }), plan({ minimumAppearances: 1.5 }), plan({ minimumAppearances: 1001 }), plan({ requireBoth: 'true' })]) {
    assert.equal((await planQuestion(question)).status, 'invalid');
  }
});

test('grouped rankings preserve reusable dimensions, count, eligibility and clarification', async t => {
  const grouping = { groupBy: 'category', categories: ['MEN', 'WOMEN'], ageGroup: 'ALL', limit: 1 };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.format.properties.groupBy.enum, ['none', 'category', 'competition', 'team']);
    return mockResponse(plan({ operation: 'leaderboard', player: '', metric: 'goalContributions',
      basis: 'clarify', minimumAppearances: 12, requireBoth: true, ...grouping }));
  });
  const result = await planQuestion({ question: 'One male and one female contributor with high rates, minimum 12 games', rankingBasis: 'perAppearance' });
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.intent, { operation: 'leaderboard', metric: 'goalContributions',
    basis: 'perAppearance', minimumAppearances: 12, requireBoth: true, ...grouping });
});

test('grouping plans reject invalid dimensions, counts and metadata filters', async t => {
  let value;
  t.mock.method(globalThis, 'fetch', async () => mockResponse(value));
  for (const invalid of [{ groupBy: 'nationality' }, { limit: 0 }, { limit: 11 }, { limit: 1.5 },
    { categories: 'WOMEN' }, { categories: ['MEN', 'MEN'] }, { categories: ['UNKNOWN'] }, { ageGroup: 'U21' }]) {
    value = plan({ operation: 'leaderboard', player: '', metric: 'goals', ...invalid });
    assert.equal((await planQuestion({ question: 'Rank players' })).status, 'invalid');
  }
});

test('refuses a different responding model or a token-limit completion', async t => {
  let response = mockResponse(plan({}), 'llama3.2:3b');
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal((await planQuestion(question, { model: 'qwen3.8:27b' })).status, 'unavailable');
  response = new Response(JSON.stringify({ model: 'qwen3.8:27b', done: true, done_reason: 'length', message: { content: JSON.stringify(plan({})) } }));
  assert.equal((await planQuestion(question, { model: 'qwen3.8:27b' })).status, 'unavailable');
});

test('rejects fabricated identifiers, metrics, operations and answer fields', async t => {
  let value;
  t.mock.method(globalThis, 'fetch', async () => mockResponse(value));
  for (value of [plan({ player: 'Omar Housni Extra' }), plan({ team: 'none specified' }),
    plan({ season: '2024-2025' }), plan({ metric: 'xG' }), plan({ operation: 'run_sql' }),
    plan({ goals: 99 }), plan({ competition: 'Botola Pro D1' })]) {
    const result = await planQuestion(question);
    assert.equal(result.status, 'invalid', JSON.stringify(value));
    assert.equal(result.intent, null);
  }
});

test('accepts explicit scope while preserving conflict resolution for the engine', async t => {
  t.mock.method(globalThis, 'fetch', async () => mockResponse(plan({ season: '2024/25', competition: 'Coupe du Trône' })));
  const result = await planQuestion({ question: 'Omar Housni assists in Coupe du Trône 2024/25', context: { season: '2025-2026', competition: 'Botola Pro D1' } });
  assert.equal(result.status, 'planned');
  assert.equal(result.intent.season, '2024-2025');
  assert.equal(result.intent.competition, 'Coupe du Trône');
});

test('unsupported intent strips extra scope and missing subjects ask for clarification', async t => {
  let value = plan({ operation: 'unsupported', player: '', metric: 'none' });
  t.mock.method(globalThis, 'fetch', async () => mockResponse(value));
  let result = await planQuestion({ question: 'Who is better?' });
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.intent, { operation: 'unsupported' });
  value = plan({ player: '', metric: 'none' });
  result = await planQuestion({ question: 'Show totals', context: { player: 'All' } });
  assert.equal(result.status, 'unsupported');
  assert.match(result.reason, /Which player should I use/);
});

test('handles malformed JSON, HTTP failure, incomplete output and timeout without fallback', async t => {
  let response;
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  response = new Response(JSON.stringify({ done: true, message: { content: '{bad' } }));
  assert.equal((await planQuestion(question)).status, 'invalid');
  response = new Response('not running', { status: 503 });
  assert.equal((await planQuestion(question)).status, 'unavailable');
  response = new Response(JSON.stringify({ done: false, message: { content: '{}' } }));
  assert.equal((await planQuestion(question)).status, 'unavailable');
  response = new DOMException('timed out', 'TimeoutError');
  const timedOut = await planQuestion(question);
  assert.equal(timedOut.status, 'unavailable');
  assert.match(timedOut.reason, /timeout/);
  response = new Response('x'.repeat(33000));
  assert.equal((await planQuestion(question)).status, 'unavailable');
  assert.equal(mock.mock.callCount(), 5);
});

test('real installed model: English, French, scope and unsupported questions', { skip: process.env.LOCAL_MODEL_LIVE_TESTS !== '1' }, async t => {
  const samples = [
    ['Who has the most assists?', {}, 'leaderboard', 'assists'],
    ['Qui a le plus de passes décisives ?', {}, 'leaderboard', 'assists'],
    ['Qui a le plus de passes décisives ?', { competition: 'Botola Pro D1', season: '2025-2026' }, 'leaderboard', 'assists'],
    ['Show top scorers', { competition: 'Botola Pro D1', season: '2025-2026' }, 'leaderboard', 'goals'],
    ['How many assists did Omar Housni make?', {}, 'player_totals', 'assists'],
    ['Combien de buts a marqué Omar Housni ?', {}, 'player_totals', 'goals'],
    ['Show statistics for Raja Casablanca', {}, 'team_totals', undefined],
    ['Which player is better?', {}, 'unsupported', undefined],
    ['Give me expected goals for Raja Casablanca', {}, 'unsupported', undefined],
  ];
  for (const [question, context, operation, metric] of samples) {
    const result = await planQuestion({ question, context });
    t.diagnostic(`${operation}: ${result.status}, ${result.latencyMs}ms`);
    assert.equal(result.intent?.operation, operation, JSON.stringify(result));
    assert.equal(result.intent?.metric, metric, JSON.stringify(result));
  }
});

test('real planner plus validated data engine preserves actual assists and selected scope', { skip: process.env.LOCAL_MODEL_LIVE_TESTS !== '1' }, async t => {
  const { executePlan } = await import('./engine.mjs');
  const scope = { season: '2025-2026', competition: 'Botola Pro D1' };
  for (const body of [
    { question: 'Combien de passes décisives a fait Omar Housni ?', context: scope },
    { question: 'Qui a le plus de passes décisives ?', context: scope },
  ]) {
    const planned = await planQuestion(body);
    assert.equal(planned.status, 'planned', JSON.stringify(planned));
    const result = executePlan(planned.intent, body);
    assert.equal(result.evidence.scope.season, scope.season);
    assert.equal(result.evidence.scope.competition, scope.competition);
    assert.equal(result.evidence.isSynthetic, true);
    assert.ok(result.rows.length > 0);
    if (planned.intent.operation === 'player_totals') {
      assert.equal(result.rows[0].assists, 8);
      assert.equal(result.rows[0].appearances, 23);
    } else {
      assert.ok(result.rows.every((row, index) => index === 0 || row.assists <= result.rows[index - 1].assists));
    }
    t.diagnostic(`engine ${planned.intent.operation}: ${planned.latencyMs}ms, ${result.rows.length} result rows`);
  }
});
