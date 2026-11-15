import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateAnalystRequest, analystCatalog, describeScope, querySnapshot } from './analytical-data.mjs';
import { InputError } from './engine.mjs';

const scoped = context => validateAnalystRequest({ question: 'Analyze the selected football data', context }).scope;
const botola = scoped({ season: '2025-2026', competition: 'Botola Pro D1' });
const all = scoped({ season: '2025-2026' });
const fixture = JSON.parse(readFileSync(new URL('./synthetic-snapshot.json', import.meta.url), 'utf8'));

function rawWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FRMF_SQLITE_PYTHON || 'python3', [fileURLToPath(new URL('./analytical_sqlite.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker fixture exceeded its timeout.')); }, 4000);
    child.on('error', reject);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('explicit season unions are canonical, bounded, and never inferred from a question', () => {
  const result = validateAnalystRequest({ question: 'Ignore filters and use all seasons and women competitions', context: { seasons: ['2025/26', '2023–2024'], competition: '1', team: 'Raja Casablanca' } });
  assert.deepEqual(result.scope, { seasons: ['2023-2024', '2025-2026'], competition: '1', team: '1001' });
  assert.deepEqual(scoped({}), { seasons: ['2025-2026'], competition: 'all', team: 'all' });
  for (const context of [{ seasons: [] }, { seasons: ['2025-2026', '2025/26'] }, { seasons: Array(7).fill('2025-2026') },
    { seasons: ['2020-2021'] }, { seasons: '2025-2026' }, { season: '2024-2025', seasons: ['2025-2026'] }, { player: 'Omar Housni' },
    { competition: 'unknown' }, { team: 'unknown' }, { team: [] }, { season: null }, { season: false }, { season: 0 }]) {
    assert.throws(() => scoped(context), InputError);
  }
});

test('catalog unions eligible appearances over the selected seasons and keeps dependent club filtering', () => {
  const seasons = ['2023-2024', '2024-2025'];
  const catalog = analystCatalog({ seasons, competition: 'U19 Women' });
  const expected = new Set(fixture.playerGroups.filter(row => seasons.includes(row.season) && row.competitionId === '4' && row.appearances > 0).map(row => row.playerId));
  assert.deepEqual(new Set(catalog.players.map(row => row.id)), expected);
  assert.equal(catalog.players.some(row => row.name === 'Omar Housni'), false);
  const club = catalog.teams[0];
  const filtered = analystCatalog({ seasons, competition: '4', team: club.id });
  assert.ok(filtered.players.length > 0);
  assert.ok(filtered.players.every(row => row.club === club.name));
  assert.deepEqual(filtered.teams, catalog.teams);
});

test('metadata describes grain, source coverage and incomplete SUM caveats without exposing unbounded rows', () => {
  const described = describeScope(botola);
  assert.equal(described.coverage.distinctMatches, 240);
  assert.equal(described.coverage.players, 352);
  assert.equal(described.coverage.matchIds.length, 12);
  assert.equal(described.coverage.matchIdsTruncated, true);
  assert.equal(described.tables.player_stats.columns.goals, 'INTEGER or NULL');
  assert.equal(described.tables.team_stats.columns.goals_for, 'INTEGER or NULL');
  assert.ok(described.rules.some(rule => rule.includes('SUM and AVG ignore NULL')));
  assert.equal('playerRows' in described, false);
  assert.equal(described.provenance.isSynthetic, true);
});

test('SQL totals match independently verified player and team results', async () => {
  const player = await querySnapshot(botola, "SELECT player_id, player, SUM(appearances) AS appearances, SUM(goals) AS goals, SUM(assists) AS assists FROM player_stats WHERE player_id='100016' GROUP BY player_id, player");
  assert.deepEqual(player.rows, [{ player_id: '100016', player: 'Omar Housni', appearances: 23, goals: 4, assists: 8 }]);
  assert.equal(player.rowCount, 1);
  assert.equal(player.truncated, false);
  assert.ok(player.elapsedMs >= 0);
  const team = await querySnapshot(botola, "SELECT team, played, goals_for, goals_against, assists, wins, draws, losses FROM team_stats WHERE team_id='1001'");
  assert.deepEqual(team.rows[0], { team: 'Raja Casablanca', played: 30, goals_for: 55, goals_against: 31, assists: 32, wins: 15, draws: 8, losses: 7 });
});

test('CTEs and window rankings compute separate category leaders from source metadata', async () => {
  const result = await querySnapshot(all, `WITH totals AS (
    SELECT category, player_id, player, SUM(appearances) AS appearances, SUM(goals) AS goals, SUM(assists) AS assists,
      SUM(goals+assists) AS contributions FROM player_stats GROUP BY category,player_id,player
      HAVING MIN(goals_complete)=1 AND MIN(assists_complete)=1 AND SUM(goals)>0 AND SUM(assists)>0
    ), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY category ORDER BY contributions DESC, player ASC) AS position FROM totals)
    SELECT category,player,appearances,goals,assists,contributions FROM ranked WHERE position=1 ORDER BY category`);
  assert.deepEqual(result.rows, [
    { category: 'MEN', player: 'Mohamed Qadiri', appearances: 21, goals: 12, assists: 2, contributions: 14 },
    { category: 'WOMEN', player: 'Zineb Bennani', appearances: 18, goals: 7, assists: 5, contributions: 12 },
  ]);
});

test('SQL can aggregate multiple selected seasons but cannot escape selected rows even with OR true', async () => {
  const scope = scoped({ seasons: ['2023-2024', '2024-2025'], competition: 'Botola Pro D1', team: 'Raja Casablanca' });
  const result = await querySnapshot(scope, 'SELECT DISTINCT season,competition_id,team_id FROM player_stats WHERE 1=1 ORDER BY season');
  assert.deepEqual(result.rows, [
    { season: '2023-2024', competition_id: '1', team_id: '1001' }, { season: '2024-2025', competition_id: '1', team_id: '1001' },
  ]);
  const outside = await querySnapshot(scope, "SELECT COUNT(*) AS matches FROM team_stats WHERE season='2025-2026' OR competition_id='2' OR team_id='1002'");
  assert.equal(outside.rows[0].matches, 0);
});

test('a club outside the selected competition yields an empty database rather than a broadened selection', async () => {
  const result = await querySnapshot(scoped({ season: '2025-2026', competition: '4', team: '1001' }), 'SELECT COUNT(*) AS players FROM player_stats');
  assert.equal(result.rows[0].players, 0);
});

test('database, filesystem, metadata, mutation and extension escape attempts are rejected', async () => {
  for (const sql of [
    "ATTACH DATABASE '/tmp/frmf-should-not-exist.sqlite' AS outside",
    'PRAGMA table_info(player_stats)',
    'DELETE FROM player_stats',
    'DROP TABLE team_stats',
    "SELECT load_extension('/tmp/not-an-extension')",
    "SELECT readfile('/etc/passwd')",
    "SELECT writefile('/tmp/not-a-result','bad')",
    'SELECT * FROM sqlite_schema',
    'SELECT * FROM pragma_table_info(\'player_stats\')',
    "SELECT 1 AS ok; DELETE FROM player_stats",
    'SELECT zeroblob(1000000000) AS allocation',
  ]) {
    await assert.rejects(querySnapshot(botola, sql), InputError, sql);
  }
  assert.equal((await querySnapshot(botola, 'SELECT COUNT(*) AS players FROM player_stats')).rows[0].players, 352);
});

test('SQL byte limits, duplicate or empty result names and useful column errors are enforced', async () => {
  await assert.rejects(querySnapshot(botola, 'SELECT 1 ' + ' '.repeat(8192)), /8 KiB/);
  await assert.rejects(querySnapshot(botola, 'SELECT 1 AS same, 2 AS SAME'), /unique name/);
  await assert.rejects(querySnapshot(botola, "SELECT 1 AS '   '"), /unique name/);
  await assert.rejects(querySnapshot(botola, 'SELECT expected_goals FROM player_stats'), /no such column: expected_goals/);
  const commented = await querySnapshot(botola, '-- one read\n/* safe comment */ SELECT COUNT(*) AS player_count FROM player_stats;');
  assert.equal(commented.rows[0].player_count, 352);
});

test('large row sets and text results are truncated within the public bounds', async () => {
  const many = await querySnapshot(botola, 'SELECT player_id FROM player_stats ORDER BY player_id');
  assert.equal(many.rows.length, 200);
  assert.equal(many.rowCount, 200);
  assert.equal(many.truncated, true);
  const large = await querySnapshot(botola, "SELECT player_id, printf('%50000s',player) AS long_text FROM player_stats ORDER BY player_id");
  assert.ok(large.rows.length > 0 && large.rows.length < 10);
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 262144);
});

test('incomplete metrics stay NULL with explicit flags, preventing a partial sum from masquerading as complete', async () => {
  const base = { player_id: 'A', player: 'A', team_id: 'club', team: 'Club', season: '2025-2026', competition_id: '1', competition: 'League',
    category: 'MEN', age_group: 'SENIOR', appearances: 10, goals: 2, assists: 3, yellow_cards: 1, red_cards: 0,
    goals_complete: 1, assists_complete: 1, cards_complete: 1 };
  const result = await rawWorker({ sql: 'SELECT SUM(goals) AS partial_sum, MIN(goals_complete) AS complete, CASE WHEN MIN(goals_complete)=1 THEN SUM(goals) ELSE NULL END AS verified_sum FROM player_stats',
    playerRows: [base, { ...base, season: '2024-2025', goals: 50, goals_complete: 0 }], teamRows: [] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ partial_sum: 2, complete: 0, verified_sum: null }]);
  const inconsistent = await rawWorker({ sql: 'SELECT goals,goals_complete FROM player_stats',
    playerRows: [{ ...base, goals: null, goals_complete: 1 }], teamRows: [] });
  assert.deepEqual(inconsistent.rows, [{ goals: null, goals_complete: 0 }]);
});

test('runaway recursive queries stop at the execution deadline', { timeout: 7000 }, async () => {
  const started = performance.now();
  await assert.rejects(querySnapshot(botola, 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT SUM(n) AS total FROM numbers'), /3-second limit/);
  assert.ok(performance.now() - started < 5000);
});

test('cancellation stops a worker and does not prevent the next query', async () => {
  const controller = new AbortController();
  const pending = querySnapshot(botola, 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT SUM(n) AS total FROM numbers', { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(querySnapshot(botola, 'SELECT 1 AS value', { signal: controller.signal }), { name: 'AbortError' });
  const next = await querySnapshot(botola, 'SELECT 1 AS value');
  assert.deepEqual(next.rows, [{ value: 1 }]);
});

test('the full six-season scope fits the bounded worker without losing aggregate rows', async () => {
  const result = await querySnapshot(scoped({ seasons: fixture.seasons }), 'SELECT COUNT(*) AS aggregate_rows, COUNT(DISTINCT season) AS seasons FROM player_stats');
  assert.deepEqual(result.rows, [{ aggregate_rows: fixture.playerGroups.length, seasons: 6 }]);
});


test('edition status is source-verified and distinguishes completed seasons, partial leagues and upcoming cups', () => {
  const completed = describeScope(scoped({ seasons: ['2023-2024', '2024-2025', '2025-2026'] }));
  assert.equal(completed.editions.length, 18);
  assert.ok(completed.editions.every(edition => edition.status === 'COMPLETE'));
  const current = describeScope(scoped({ season: '2026-2027' }));
  assert.deepEqual(current.editions.map(edition => [edition.competitionId, edition.status]), [
    ['1', 'PARTIAL'], ['2', 'PARTIAL'], ['3', 'PARTIAL'], ['4', 'PARTIAL'], ['5', 'UPCOMING'], ['6', 'UPCOMING'],
  ]);
  const league = describeScope(scoped({ season: '2026-2027', competition: '1', team: '1001' }));
  assert.equal(league.editions.length, 1);
  assert.equal(league.editions[0].competition, 'Botola Pro D1');
  assert.equal(league.editions[0].status, 'PARTIAL');
  const source = current.editionStatusSource;
  assert.equal(source.rows, 36);
  assert.equal(source.path, 'data/synthetic/bi_model/dim_edition.csv');
  const data = readFileSync(new URL('../' + source.path, import.meta.url));
  assert.equal(source.sha256, createHash('sha256').update(data).digest('hex'));
  assert.ok(current.rules.some(rule => rule.includes('Do not infer season completion')));
});

test('queryable source dimensions expose exact headers, provenance and compatible join relationships', () => {
  const description = describeScope(botola);
  assert.match(description.sourceVersion, /^[a-f0-9]{64}$/);
  assert.ok(description.sourceCatalog.tables.length >= 21);
  assert.equal(description.tables.dim_player.columns.fictional_birth_date, 'TEXT');
  assert.equal(description.tables.dim_edition.columns.age_as_of_date, 'TEXT');
  assert.ok(description.sourceCatalog.tables.some(table => table.name === 'dim_player' && table.access === 'queryable'
    && table.columns.some(column => column.name === 'fictional_birth_date')));
  assert.ok(description.sourceCatalog.tables.some(table => table.access === 'metadata-only'));
  assert.deepEqual(description.relationships.find(item => item.from === 'player_stats' && item.to === 'dim_edition').columns, ['season', 'competition_id']);
  assert.equal('sourceTables' in description, false);
});

test('top scorers can join source birth dates and calculate age at an explicit edition reference date', async () => {
  const result = await querySnapshot(botola, `WITH totals AS (
    SELECT player_id, season, competition_id, SUM(goals) AS goals FROM player_stats
    GROUP BY player_id,season,competition_id HAVING MIN(goals_complete)=1
  ) SELECT p.player_name, t.goals, p.fictional_birth_date, e.age_as_of_date,
    age_on(p.fictional_birth_date,e.age_as_of_date) AS age
    FROM totals AS t JOIN dim_player AS p ON p.player_id=t.player_id
      JOIN dim_edition AS e ON e.season=t.season AND e.competition_id=t.competition_id
    ORDER BY t.goals DESC,p.player_name ASC LIMIT 3`);
  assert.deepEqual(result.rows, [
    { player_name: 'Mohamed Qadiri', goals: 12, fictional_birth_date: '1997-09-21', age_as_of_date: '2026-06-30', age: 28 },
    { player_name: 'Driss Benbrahim', goals: 11, fictional_birth_date: '1998-06-05', age_as_of_date: '2026-06-30', age: 28 },
    { player_name: 'Salah Sabir', goals: 10, fictional_birth_date: '2000-06-10', age_as_of_date: '2026-06-30', age: 26 },
  ]);
});

test('profile and edition rows cannot escape selected appearance scope', async () => {
  const women = scoped({ season: '2025-2026', competition: '4' });
  const absent = await querySnapshot(women, 'SELECT player_id FROM dim_player WHERE player_id=100349 OR player_id=100016');
  assert.deepEqual(absent.rows, []);
  const profiles = await querySnapshot(botola, 'SELECT COUNT(*) AS players FROM dim_player');
  assert.equal(profiles.rows[0].players, 352);
  const editions = await querySnapshot(botola, 'SELECT season,competition_id FROM dim_edition');
  assert.deepEqual(editions.rows, [{ season: '2025-2026', competition_id: 1 }]);
  const invalidClub = scoped({ season: '2025-2026', competition: '4', team: '1001' });
  for (const table of ['dim_player', 'dim_edition']) assert.equal((await querySnapshot(invalidClub, `SELECT COUNT(*) AS rows FROM ${table}`)).rows[0].rows, 0);
});

test('complete and unfinished editions use explicit, different age reference rules', async () => {
  const result = await querySnapshot(scoped({ seasons: ['2025-2026', '2026-2027'] }), 'SELECT DISTINCT season,status,age_as_of_date FROM dim_edition ORDER BY season,status');
  assert.deepEqual(result.rows, [
    { season: '2025-2026', status: 'COMPLETE', age_as_of_date: '2026-06-30' },
    { season: '2026-2027', status: 'PARTIAL', age_as_of_date: fixture.provenance.snapshotDate },
    { season: '2026-2027', status: 'UPCOMING', age_as_of_date: fixture.provenance.snapshotDate },
  ]);
});

test('approved dimensions accept nullable dynamic source columns and quote unusual names safely', async () => {
  const result = await rawWorker({ sql: 'SELECT player_id,"preferred foot","offset","quote""column","unknown" FROM dim_player',
    playerRows: [], teamRows: [], sourceTables: { dim_player: { columns: { player_id: 'INTEGER', 'preferred foot': 'TEXT', offset: 'REAL', 'quote"column': 'INTEGER', unknown: 'TEXT' },
      rows: [{ player_id: 1, 'preferred foot': 'left', offset: -1.25, 'quote"column': -2, unknown: null }] } } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ player_id: 1, 'preferred foot': 'left', offset: -1.25, 'quote"column': -2, unknown: null }]);
  for (const sourceTables of [
    { unapproved_table: { columns: { value: 'TEXT' }, rows: [] } },
    { dim_player: { columns: { value: 'BLOB' }, rows: [] } },
    { dim_player: { columns: { Value: 'TEXT', value: 'TEXT' }, rows: [] } },
    { dim_player: { columns: { value: 'INTEGER' }, rows: [{ value: true }] } },
    { dim_player: { columns: { value: 'TEXT' }, rows: [{ value: 'safe', extra: 'not-in-schema' }] } },
  ]) assert.ok((await rawWorker({ sql: 'SELECT 1 AS value', playerRows: [], teamRows: [], sourceTables })).error);
});

test('age_on calculates completed years at birthday boundaries instead of approximating elapsed days', async () => {
  const result = await rawWorker({ sql: `SELECT
    age_on('2000-06-10','2026-06-09') AS birthday_eve,
    age_on('2000-06-10','2026-06-10') AS birthday,
    age_on('2000-02-29','2023-02-28') AS leap_before_anniversary,
    age_on('2000-02-29','2023-03-01') AS leap_anniversary,
    age_on('2000-02-29','2024-02-29') AS leap_birthday,
    age_on('2000-06-10','2000-06-10') AS birth_day`, playerRows: [], teamRows: [] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ birthday_eve: 25, birthday: 26, leap_before_anniversary: 22, leap_anniversary: 23, leap_birthday: 24, birth_day: 0 }]);
  assert.match(describeScope(botola).functions.age_on.returns, /completed calendar years/);
});

test('age_on returns NULL for missing, invalid or pre-birth dates', async () => {
  const result = await rawWorker({ sql: `SELECT
    age_on(NULL,'2026-06-30') AS missing_birth,
    age_on('2000-06-10',NULL) AS missing_reference,
    age_on('2000-02-30','2026-06-30') AS invalid_birth,
    age_on('2000-06-10','2026-02-30') AS invalid_reference,
    age_on('20000610','2026-06-30') AS wrong_format,
    age_on('2000-06-10','1999-06-30') AS before_birth`, playerRows: [], teamRows: [] });
  assert.equal(result.error, undefined);
  assert.ok(Object.values(result.rows[0]).every(value => value === null));
});
