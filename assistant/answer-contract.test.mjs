import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTasks, assembleSections, incompleteSections } from './answer-contract.mjs';

const tasks = [{ id: 'T1', label: 'Goals leader' }, { id: 'T2', label: 'Assists leader' }];
const queries = [
  { id: 'Q1', columns: ['player_id', 'player', 'goals', 'goals_complete'], rows: [{ player_id: '1', player: 'Scorer', goals: 12, goals_complete: 1 }], truncated: false },
  { id: 'Q2', columns: ['player_id', 'player', 'assists', 'assists_complete'], rows: [{ player_id: '2', player: 'Creator', assists: 8, assists_complete: 1 }], truncated: false },
];
const descriptor = (index, overrides = {}) => ({ title: tasks[index].label, query_id: `Q${index + 1}`,
  task_ids: [tasks[index].id], columns: [], row_indices: [], status: 'answered', note: '', ...overrides });
const plain = message => message;

test('independent requested leaders retain separate tables and unaltered evidence', () => {
  const evidenceBefore = structuredClone(queries);
  const sections = assembleSections([descriptor(0), descriptor(1)], tasks, queries, plain);
  assert.deepEqual(sections.map(section => section.rows), [[{ player: 'Scorer', goals: 12 }], [{ player: 'Creator', assists: 8 }]]);
  assert.deepEqual(sections.map(section => section.queryId), ['Q1', 'Q2']);
  assert.deepEqual(queries, evidenceBefore);
});

test('one combined query can supply distinct leader sections using actual row indices', () => {
  const combined = [{ id: 'Q1', columns: ['player', 'goals', 'assists'], rows: [
    { player: 'Scorer', goals: 12, assists: 2 }, { player: 'Creator', goals: 4, assists: 8 },
  ], truncated: false }];
  const duplicate = [descriptor(0), descriptor(1, { query_id: 'Q1' })];
  assert.throws(() => assembleSections(duplicate, tasks, combined, plain), /repeat the same query rows/);
  const results = assembleSections([descriptor(0, { row_indices: [0] }), descriptor(1, { query_id: 'Q1', row_indices: [1] })], tasks, combined, plain);
  assert.deepEqual(results.map(section => section.rows), [[combined[0].rows[0]], [combined[0].rows[1]]]);
  assert.throws(() => assembleSections([descriptor(0, { row_indices: [3] })], tasks.slice(0, 1), combined, plain), /actual rows/);
});

test('answers cannot silently drop recorded tasks or cited results', () => {
  assert.throws(() => assembleSections([descriptor(1)], tasks, queries, plain), /omits requested analyses.*T1/);
  assert.throws(() => assembleSections([descriptor(1, { task_ids: ['T1', 'T2'] })], tasks, queries, plain), /Every cited result/);
  assert.throws(() => validateTasks([tasks[1]], tasks), /checklist is already recorded/);
  assert.deepEqual(validateTasks([], tasks), tasks);
});

test('repeated task IDs retain the recorded labels and order despite harmless rewriting', () => {
  const variants = [
    tasks.map(({ id, label }) => ({ label, id })),
    [...tasks].reverse(),
    [{ id: 'T2', label: 'Leading assist provider' }, { id: 'T1', label: 'Leading scorer' }],
  ];
  for (const repeated of variants) {
    const preserved = validateTasks(repeated, tasks);
    assert.deepEqual(preserved, tasks);
    preserved[0].label = 'Changed by caller';
    assert.equal(tasks[0].label, 'Goals leader');
  }
});

test('repeated checklists still reject dropped, replaced, added and duplicated task IDs', () => {
  for (const changed of [
    [tasks[0]],
    [tasks[0], { id: 'T3', label: 'Another analysis' }],
    [...tasks, { id: 'T3', label: 'Another analysis' }],
  ]) assert.throws(() => validateTasks(changed, tasks), /checklist is already recorded/);
  assert.throws(() => validateTasks([tasks[0], tasks[0]], tasks), /distinct tasks/);
});

test('unknown tasks, query references and columns cannot fabricate a displayed result', () => {
  for (const overrides of [{ task_ids: ['T8'] }, { query_id: 'Q8' }, { columns: ['invented_assists'] }]) {
    assert.throws(() => assembleSections([descriptor(0, overrides), descriptor(1)], tasks, queries, plain));
  }
});

test('empty queries and unavailable parts remain visible without invented zero performance', () => {
  const empty = [{ ...queries[0], rows: [] }];
  const sections = assembleSections([descriptor(0), descriptor(1, { status: 'unavailable', query_id: '',
    note: 'Played minutes are not connected, so a per-minute rate cannot be calculated.' })], tasks, empty, plain);
  assert.equal(sections[0].status, 'empty');
  assert.match(sections[0].note, /does not mean zero performance/);
  assert.equal(sections[1].status, 'unavailable');
  assert.deepEqual(sections[1].rows, []);
  assert.throws(() => assembleSections([descriptor(0), descriptor(1, { status: 'unavailable', query_id: '' })], tasks, empty, plain), /specific missing-data/);
});

test('incomplete coverage remains a readable warning after flags are hidden', () => {
  const partial = [{ ...queries[0], rows: [{ player_id: '1', player: 'Scorer', goals: null, goals_complete: 0 }] }];
  const [result] = assembleSections([descriptor(0)], tasks.slice(0, 1), partial, plain);
  assert.deepEqual(result.columns, ['player', 'goals']);
  assert.equal(result.rows[0].goals, null);
  assert.equal(result.status, 'incomplete');
  assert.match(result.warnings.join(' '), /Some goals records are missing/);
  assert.match(result.warnings.join(' '), /Missing data is not zero/);
});

test('interrupted investigation preserves every calculated table and unconfirmed task', () => {
  const sections = incompleteSections(queries, tasks);
  assert.deepEqual(sections.filter(section => section.queryId).map(section => section.queryId), ['Q1', 'Q2']);
  assert.deepEqual(sections.filter(section => !section.queryId).flatMap(section => section.taskIds), ['T1', 'T2']);
  assert.ok(sections.every(section => section.status === 'incomplete'));
});

test('a missing requested profile field remains partial without a completeness flag', () => {
  const query = { id: 'Q1', columns: ['player', 'age'], rows: [{ player: 'Scorer', age: null }], truncated: false };
  const [result] = assembleSections([descriptor(0)], tasks.slice(0, 1), [query], plain);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.rows[0].age, null);
  assert.match(result.warnings[0], /Missing data is not zero/);
});

test('partial display previews stay bounded while retaining full query evidence', () => {
  const rows = Array.from({ length: 150 }, (_row, index) => ({ player: 'Player ' + index, detail: 'x'.repeat(900) }));
  const queries = [{ id: 'Q1', columns: ['player', 'detail'], rows, truncated: false }];
  const [section] = incompleteSections(queries, tasks.slice(0, 1));
  assert.ok(section.rows.length < 150 && section.rows.length > 0);
  assert.match(section.note, /display preview/);
  assert.equal(queries[0].rows.length, 150);
  assert.ok(Buffer.byteLength(JSON.stringify(section)) < 12000);
});
