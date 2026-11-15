import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseQuestion, renderGroundedMessage } from './analytical-agent.mjs';
import { validateAnalystRequest, describeScope } from './analytical-data.mjs';
import { createPilotServer } from './server.mjs';
import { readChatResponse } from './public/progress-state.mjs';

const model = 'qwen3.8:27b';
const scope = { seasons: ['2025-2026'], competition: '1', team: 'all' };
const sql = `SELECT player_id, player, SUM(appearances) AS appearances, SUM(goals) AS goals, SUM(assists) AS assists
FROM player_stats WHERE player = 'Omar Housni' GROUP BY player_id, player`;
const tasks = [{ id: 'T1', label: 'Requested analysis' }];
const section = (id, taskIds = ['T1']) => ({ title: 'Recorded results', query_id: id, task_ids: taskIds, columns: [], row_indices: [], status: 'answered', note: '' });
const query = statement => ({ action: 'query', sql: statement, message: '', result_ids: [], options: [], tasks, sections: [] });
const answer = (message, ids = ['Q1']) =>
  ({ action: 'answer', sql: '', message: message ?? `The selected records show {{${ids[0]}:0:player}} with {{${ids[0]}:0:appearances}} appearances, {{${ids[0]}:0:goals}} goals and {{${ids[0]}:0:assists}} assists. [${ids[0]}]`, result_ids: ids, options: [], tasks: [], sections: ids.map(id => section(id)) });
const clarify = message => ({ action: 'clarify', sql: '', message, result_ids: [], tasks, sections: [], options: ['Assists first, then goals per appearance', 'Combined goals + assists'] });

function fakeModel(t, actions) {
  const original = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) !== 'http://127.0.0.1:11435/api/chat') return original(url, options);
    calls.push(JSON.parse(options.body));
    const action = actions.shift();
    assert.ok(action, 'Unexpected extra local-model call');
    return new Response(JSON.stringify({ model, done: true, message: { content: typeof action === 'string' ? action : JSON.stringify(action) } }));
  });
  return calls;
}

test('analyst executes SQL, reads actual data, and displays only returned rows', async t => {
  const calls = fakeModel(t, [query(sql), answer()]);
  const stages = [];
  const result = await analyseQuestion({ question: 'Compare scoring and creating for Omar Housni.', scope }, { onProgress: stage => stages.push(stage) });
  assert.equal(result.status, 'answered');
  assert.equal(result.mode, 'local-analyst');
  assert.equal(result.rows[0].assists, 8);
  assert.equal(result.rows[0].goals, 4);
  assert.equal(result.rows[0].appearances, 23);
  assert.equal(result.evidence.queries[0].sql, sql);
  assert.equal(result.modelCalls, 2);
  assert.ok(stages.includes('querying') && stages.includes('reviewing'));
  assert.match(calls[1].messages.at(-1).content, /"assists":8/);
  assert.match(calls[0].messages[0].content, /There is no fixed list/);
});

test('SQL errors can be corrected and cannot masquerade as successful evidence', async t => {
  const calls = fakeModel(t, [query('SELECT invented_metric FROM player_stats'), query(sql), answer()]);
  const result = await analyseQuestion({ question: 'Show the recorded contribution numbers.', scope });
  assert.equal(result.status, 'answered');
  assert.equal(result.evidence.queries.length, 1);
  assert.equal(result.evidence.queries[0].id, 'Q1');
  assert.match(calls[1].messages.at(-1).content, /error/);
});

test('multi-part answers must display earlier requested results, including for legacy clients', async t => {
  const checklist = [{ id: 'T1', label: 'Scoring leader' }, { id: 'T2', label: 'Assisting leader' }];
  const goalsSql = `WITH totals AS (SELECT player_id, player, SUM(goals) AS goals FROM player_stats GROUP BY player_id, player)
    SELECT player, goals FROM totals WHERE goals = (SELECT MAX(goals) FROM totals)`;
  const assistsSql = `WITH totals AS (SELECT player_id, player, SUM(assists) AS assists FROM player_stats GROUP BY player_id, player)
    SELECT player, assists FROM totals WHERE assists = (SELECT MAX(assists) FROM totals)`;
  const complete = { ...answer('Separate leaders calculated in the selected scope.', ['Q1', 'Q2']), sections: [
    { ...section('Q1', ['T1']), title: 'Goals leaders' }, { ...section('Q2', ['T2']), title: 'Assist leaders' },
  ] };
  const calls = fakeModel(t, [{ ...query(goalsSql), tasks: checklist }, { ...query(assistsSql), tasks: [] },
    { ...complete, sections: complete.sections.slice(1) }, complete]);
  const result = await analyseQuestion({ question: 'Who leads goals and who leads assists?', scope });
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.displayedQueries, ['Q1', 'Q2']);
  assert.equal(result.sections[0].rows[0].player, 'Mohamed Qadiri');
  assert.equal(result.sections[1].rows[0].player, 'Omar Housni');
  assert.deepEqual(result.rows.map(row => row.result_section), ['Goals leaders', 'Assist leaders']);
  assert.match(calls[3].messages.at(-1).content, /omits requested analyses/);
});

test('clarification after a query preserves its calculated table as unconfirmed', async t => {
  fakeModel(t, [query(sql), clarify('Which rate denominator should I use for the remaining comparison?')]);
  const result = await analyseQuestion({ question: 'Show Omar totals and compare his scoring rate.', scope });
  assert.equal(result.status, 'clarification');
  assert.equal(result.sections[0].status, 'incomplete');
  assert.equal(result.sections[0].queryId, 'Q1');
  assert.equal(result.sections[0].rows[0].player, 'Omar Housni');
  assert.deepEqual(result._state.tasks, tasks);
});

test('identical queries reuse pinned evidence instead of producing repeated tables', async t => {
  const calls = fakeModel(t, [query(sql), query(sql), answer()]);
  const result = await analyseQuestion({ question: 'Show Omar totals.', scope });
  assert.equal(result.status, 'answered');
  assert.equal(result.evidence.queries.length, 1);
  assert.equal(result.sections.length, 1);
  assert.match(calls[2].messages.at(-1).content, /exact query already ran/);
  assert.deepEqual(result.evidence.diagnostics.map(item => item.outcome), ['executed', 'reused', 'returned']);
});

test('cached result reuse leaves SQL budget for a corrective query', async t => {
  const second = sql.replaceAll('Omar Housni', 'Mohamed Qadiri');
  fakeModel(t, [query(sql), query(sql), query(sql), query(sql), query(second), answer(undefined, ['Q2'])]);
  const result = await analyseQuestion({ question: 'Compare the recorded players.', scope });
  assert.equal(result.status, 'answered');
  assert.equal(result.modelCalls, 6);
  assert.equal(result.evidence.queries.length, 2);
  assert.equal(result.evidence.diagnostics.filter(item => item.outcome === 'reused').length, 3);
});

test('incomplete answers retain mechanical rejection evidence without raw model output', async t => {
  const invalid = { ...answer('This unsupported statistic is 999.'), message: 'This unsupported statistic is 999.' };
  fakeModel(t, [query(sql), ...Array.from({ length: 5 }, () => invalid)]);
  const result = await analyseQuestion({ question: 'Show Omar totals.', scope });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.evidence.diagnostics.length, 6);
  assert.equal(result.evidence.diagnostics[1].outcome, 'rejected');
  assert.match(result.evidence.diagnostics[1].detail, /unbound numbers/);
  assert.doesNotMatch(JSON.stringify(result.evidence.diagnostics), /999/);
  assert.equal(result.sections[0].rows[0].assists, 8);
});

test('malformed model output retains calculated rows without exposing its parser excerpt', async t => {
  fakeModel(t, [query(sql), 'UNVALIDATED_MODEL_DRAFT']);
  const result = await analyseQuestion({ question: 'Show Omar totals.', scope });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.sections[0].rows[0].assists, 8);
  assert.deepEqual(result.evidence.diagnostics.at(-1), {
    turn: 2, action: 'model', outcome: 'failed', detail: 'The local model returned malformed JSON.',
  });
  assert.doesNotMatch(JSON.stringify(result), /UNVALIDATED/);
});

test('fabricated bracket citations in prose and section notes require repair', async t => {
  const badCitation = 'The recorded total is {{Q1:0:goals}}. [Q9]';
  const badNote = { ...answer(), sections: [{ ...section('Q1'), note: badCitation }] };
  const repaired = { ...answer(), sections: [{ ...section('Q1'), note: 'The recorded total is {{Q1:0:goals}}. [Q1]' }] };
  const calls = fakeModel(t, [query(sql), answer(badCitation), badNote, repaired]);
  const result = await analyseQuestion({ question: 'Show Omar totals.', scope });
  assert.equal(result.status, 'answered');
  assert.equal(result.modelCalls, 4);
  assert.match(calls[2].messages.at(-1).content, /citation refers to an unavailable query/);
  assert.match(calls[3].messages.at(-1).content, /citation refers to an unavailable query/);
  assert.equal(result.sections[0].note, 'The recorded total is 4. [Q1]');
  assert.doesNotMatch(result.answer + result.sections[0].note, /\[Q9\]/);
});

test('join duplication is diagnosed and cannot finalize a complete leaderboard', async t => {
  const duplicated = `SELECT 'Scorer' AS player, 12 AS goals UNION ALL SELECT 'Scorer', 12`;
  const corrected = `SELECT 'Scorer' AS player, 12 AS goals`;
  const calls = fakeModel(t, [query(duplicated), answer('The recorded scoring result.', ['Q1']), query(corrected), answer('The recorded scoring result.', ['Q2'])]);
  const result = await analyseQuestion({ question: 'Show the scoring result.', scope });
  assert.equal(result.status, 'answered');
  assert.match(calls[1].messages.at(-1).content, /"duplicateRows":1/);
  assert.match(calls[2].messages.at(-1).content, /indistinguishable duplicate rows/);
  assert.equal(result.sections[0].rows.length, 1);
  assert.equal(result.displayedQuery, 'Q2');
});

test('general clarification preserves the original question and uses the free-text reply', async t => {
  const original = 'Compare the female assist leader with the male leader using a high goals ratio.';
  const followup = 'Assists total first, goals per appearance second.';
  const calls = fakeModel(t, [clarify('Which ranking rule should I use?'), query(sql), answer()]);
  const first = await analyseQuestion({ question: original, scope });
  assert.equal(first.status, 'clarification');
  assert.deepEqual(first.rows, []);
  const next = await analyseQuestion({ question: followup, scope }, { state: first._state });
  assert.equal(next.status, 'answered');
  assert.ok(calls[1].messages.some(message => message.content.includes(original)));
  assert.ok(calls[1].messages.at(-1).content.includes(followup));
});

test('fabricated references and unqueried answers are repaired, not presented as evidence', async t => {
  fakeModel(t, [answer('An invented answer.', ['Q9']), query(sql), answer()]);
  const result = await analyseQuestion({ question: 'Show Omar totals.', scope });
  assert.equal(result.status, 'answered');
  assert.equal(result.answer.includes('invented answer'), false);
  assert.deepEqual(result.citedQueries, ['Q1']);
});

test('truncated output requires a complete aggregate before answering', async t => {
  const calls = fakeModel(t, [query('SELECT player_id, player, appearances FROM player_stats'), answer('Unsupported full ranking.'), query(sql), answer(undefined, ['Q2'])]);
  const result = await analyseQuestion({ question: 'Show a complete result.', scope });
  assert.equal(result.evidence.queries[0].truncated, true);
  assert.match(calls[2].messages.at(-1).content, /truncated/);
  assert.equal(result.displayedQuery, 'Q2');
});

test('model endpoint is local and cancellation reaches inference', async t => {
  await assert.rejects(analyseQuestion({ question: 'Show totals.', scope }, { baseUrl: 'https://example.com' }), /local loopback/);
  const controller = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }));
  const request = analyseQuestion({ question: 'Show totals.', scope }, { signal: controller.signal });
  await pending;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('numerical explanations bind actual cells instead of mistyping result numbers', () => {
  const queries = [{ id: 'Q1', rows: [{ player: 'Example', rate: 3 / 11 }] }];
  const description = { scope: { seasons: ['2023-2024'] } };
  assert.equal(renderGroundedMessage('{{Q1:0:player}}: {{Q1:0:rate}} per appearance in 2023–2024. [Q1]', queries, description), 'Example: 0.2727 per appearance in 2023–2024. [Q1]');
  assert.throws(() => renderGroundedMessage('The rate is 0.2726. [Q1]', queries, description), /unbound numbers/);
  assert.throws(() => renderGroundedMessage('{{Q2:0:rate}}', queries, description), /unavailable query cell/);
  assert.throws(() => renderGroundedMessage('{{Q1:9:rate}}', queries, description), /unavailable query cell/);
  assert.throws(() => renderGroundedMessage('{{Q1:0:invented}}', queries, description), /unavailable query cell/);
});

test('a rejected numeric section note receives targeted feedback and can be repaired', async t => {
  const selected = { seasons: ['2024-2025', '2025-2026'], competition: '1', team: '1002' };
  const statement = `WITH player_season AS (SELECT player_id, season, SUM(appearances) AS appearances, SUM(goals) AS goals, MIN(goals_complete) AS goals_complete FROM player_stats GROUP BY player_id, season),
    ranked AS (SELECT p.player_id, p.season, p.appearances, p.goals, p.goals_complete, RANK() OVER (PARTITION BY p.season ORDER BY p.goals DESC) AS goal_rank FROM player_season p)
    SELECT r.season, d.player_name, r.appearances, r.goals, r.goals_complete FROM ranked r JOIN dim_player d ON r.player_id = d.player_id WHERE r.goal_rank = 1 ORDER BY r.season, r.goals DESC, d.player_name`;
  const message = 'For Wydad Casablanca in Botola Pro D1, the top scorer in 2024-2025 was {{Q1:0:player_name}} with {{Q1:0:goals}} goals in {{Q1:0:appearances}} appearances, and in 2025-2026 it was {{Q1:1:player_name}} with {{Q1:1:goals}} goals in {{Q1:1:appearances}} appearances. [Q1] Each season has a single leader (no ties at the top goal total), and goal data is complete for both seasons.';
  const note = 'Ranked by total goals per season using RANK(); ties would all be shown. No ties at rank 1 in either season. Goals are complete (goals_complete=1).';
  const repairedNote = 'Ranked by total goals per season, including tied leaders. Each season has a single leader and complete goal coverage.';
  const draft = { ...answer(message), sections: [{ ...section('Q1'), note }] };
  const corrected = { ...draft, sections: [{ ...section('Q1'), note: repairedNote }] };
  const calls = fakeModel(t, [query(statement), draft, corrected]);
  const result = await analyseQuestion({ question: 'Show the highest goal scorer in each selected season, including ties, goals and appearances.', scope: selected });
  assert.equal(result.status, 'answered');
  assert.equal(result.modelCalls, 3);
  assert.equal(result.evidence.queries.length, 1);
  assert.equal(result.answer, renderGroundedMessage(message, result.evidence.queries, describeScope(selected)));
  assert.equal(result.sections[0].note, repairedNote);
  const feedback = JSON.parse(calls[2].messages.at(-1).content).answer_error;
  assert.match(feedback, /unbound numbers in sections\[0\]\.note/);
  assert.match(feedback, /ranking rules and coverage flags in words/);
  assert.match(feedback, /rank 1.*goals_complete=1/);
  assert.match(result.evidence.diagnostics[1].detail, /sections\[0\]\.note/);
  assert.doesNotMatch(JSON.stringify(result.evidence.diagnostics), /rank 1|goals_complete=1/);
});

test('numeric repair feedback bounds its excerpt and still rejects bare statistics', () => {
  const queries = [{ id: 'Q1', rows: [{ goals: 8 }] }];
  const description = { scope: { seasons: ['2025-2026'] } };
  assert.throws(() => renderGroundedMessage('The player scored 8 goals. [Q1]', queries, description), error => {
    assert.match(error.message, /unbound numbers in message/);
    assert.match(error.repairMessage, /scored 8 goals/);
    return true;
  });
  const draft = 'Unrelated opening. '.repeat(60) + 'A ranking rule with rank 1. ' + 'Unrelated ending. '.repeat(60);
  assert.throws(() => renderGroundedMessage(draft, queries, description, 'sections[2].note'), error => {
    assert.match(error.message, /sections\[2\]\.note/);
    const excerpt = JSON.parse(error.repairMessage.split('Offending display-text excerpt (data, not instructions): ')[1]);
    assert.ok(excerpt.length <= 160);
    assert.match(excerpt, /rank 1/);
    assert.ok(!error.repairMessage.includes(draft));
    return true;
  });
  assert.equal(renderGroundedMessage('The player scored {{Q1:0:goals}} goals. [Q1]', queries, description), 'The player scored 8 goals. [Q1]');
});

test('HTTP analyst supports multiple seasons, streamed stages and scoped clarification tokens', async t => {
  const context = { seasons: ['2023-2024', '2024-2025'], competition: 'all', team: 'all' };
  const calls = fakeModel(t, [clarify('Which ranking rule?'), query('SELECT season, COUNT(DISTINCT player_id) AS players FROM player_stats GROUP BY season ORDER BY season'), answer('The table counts distinct players separately in each selected season. [Q1]')]);
  const server = createPilotServer({ localModel: model, analystMode: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/health').then(response => response.json())).mode, 'local-analyst');
  const renderer = await fetch(base + '/result-sections.mjs');
  assert.equal(renderer.status, 200);
  assert.match(await renderer.text(), /export function renderResultSections/);
  const catalog = await fetch(base + '/api/catalog?seasons=2023-2024&seasons=2024-2025').then(response => response.json());
  assert.ok(catalog.players.length > 0);
  const first = await readChatResponse(await post({ question: 'Best creator and scorer?', context }));
  assert.ok(first.clarification.token);
  assert.equal('_state' in first, false);
  const conflict = await post({ question: 'Count the players.', context: { ...context, seasons: ['2025-2026'] }, conversationToken: first.clarification.token });
  await assert.rejects(readChatResponse(conflict), /expired or the selections changed/);
  assert.equal(calls.length, 1);
  const stages = [];
  const next = await readChatResponse(await post({ question: 'Count the players in each selected season.', context, conversationToken: first.clarification.token }), stage => stages.push(stage));
  assert.deepEqual(next.rows.map(row => row.season), context.seasons);
  assert.equal(stages[0], 'checking');
  assert.ok(stages.includes('querying'));
  // Already-open pages use this older whitelist; none of the events may break their parser.
  assert.ok(stages.every(stage => ['interpreting', 'checking', 'calculating', 'querying', 'reviewing', 'composing'].includes(stage)));
  assert.deepEqual(next.evidence.scope, validateAnalystRequest({ question: 'scope', context }).scope);
  const replay = await post({ question: 'Count again.', context, conversationToken: first.clarification.token });
  await assert.rejects(readChatResponse(replay), /expired or the selections changed/);
});


test('the model receives discovered source fields and differentiates disconnected data', async t => {
  const calls = fakeModel(t, [query(sql), answer()]);
  const result = await analyseQuestion({ question: 'Show the player totals.', scope });
  const contract = JSON.parse(calls[0].messages[0].content.split('DATA CONTRACT:\n')[1]);
  const profiles = contract.sourceCatalog.tables.find(table => table.name === 'dim_player');
  assert.equal(profiles.access, 'queryable');
  assert.ok(profiles.columns.includes('fictional_birth_date'));
  assert.ok(profiles.columns.includes('primary_position'));
  const incidents = contract.sourceCatalog.tables.find(table => table.name === 'fact_injury_incident');
  assert.equal(incidents.access, 'metadata-only');
  assert.ok(incidents.columns.includes('observation_kind'));
  assert.equal(result.evidence.sourceVersion, describeScope(scope).sourceVersion);
  assert.ok(result.evidence.sourceCatalog.tables.find(table => table.name === 'dim_player').columns[0].type);
});

test('changed data cannot reuse clarification evidence from an older version', async t => {
  const calls = fakeModel(t, [clarify('Which ranking rule?')]);
  const first = await analyseQuestion({ question: 'Rank the creators.', scope });
  const oldState = { ...first._state, sourceVersion: 'previous-data-version' };
  await assert.rejects(analyseQuestion({ question: 'Use assists.', scope }, { state: oldState }), /source data changed/);
  assert.equal(calls.length, 1);
});

test('source metadata endpoint publishes fields and version without source row values', async t => {
  const server = createPilotServer({ localModel: model, analystMode: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/schema`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.match(metadata.sourceVersion, /^[a-f0-9]{64}$/);
  assert.ok(metadata.tables.find(table => table.name === 'dim_player').columns.some(column => column.name === 'fictional_birth_date'));
  assert.ok(metadata.tables.every(table => !Object.hasOwn(table, 'rows')));
  assert.equal(JSON.stringify(metadata).includes('Omar Housni'), false);
});
