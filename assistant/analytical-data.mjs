import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InputError } from './engine.mjs';
import { getSnapshot } from './snapshot-store.mjs';

const workerPath = fileURLToPath(new URL('./analytical_sqlite.py', import.meta.url));
const maximumSqlBytes = 8192;
const maximumResultBytes = 262144;
const normalized = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const allValues = new Set(['', 'all', 'all competitions', 'all teams', 'all clubs', 'tous', 'toutes']);
const competitionAliases = { botola: 'Botola Pro D1', 'botola men': 'Botola Pro D1', 'coupe du trone': 'Coupe du Trône',
  'u19 women': 'Championnat National U19 Féminin', 'u19 men': 'Championnat National U19 Masculin', women: 'Championnat Féminin D1' };
const competitionById = () => new Map(getSnapshot().competitions.map(item => [String(item.id), item]));

const schemas = {
  player_stats: {
    grain: 'One player, team, season and competition aggregate; appearances are actual appearances, not unused bench selections.',
    columns: {
      player_id: 'TEXT', player: 'TEXT', team_id: 'TEXT', team: 'TEXT', season: 'TEXT', competition_id: 'TEXT', competition: 'TEXT', category: 'TEXT: MEN or WOMEN', age_group: 'TEXT: SENIOR or U19',
      appearances: 'INTEGER', goals: 'INTEGER or NULL', assists: 'INTEGER or NULL', yellow_cards: 'INTEGER or NULL', red_cards: 'INTEGER or NULL',
      goals_complete: 'INTEGER: 0 or 1', assists_complete: 'INTEGER: 0 or 1', cards_complete: 'INTEGER: 0 or 1',
    },
  },
  team_stats: {
    grain: 'One team, season and competition aggregate; each played match contributes to both participating teams when both are in scope.',
    columns: {
      team_id: 'TEXT', team: 'TEXT', season: 'TEXT', competition_id: 'TEXT', competition: 'TEXT', category: 'TEXT: MEN or WOMEN', age_group: 'TEXT: SENIOR or U19',
      played: 'INTEGER', goals_for: 'INTEGER or NULL', goals_against: 'INTEGER or NULL', assists: 'INTEGER or NULL',
      wins: 'INTEGER', draws: 'INTEGER', losses: 'INTEGER', goals_complete: 'INTEGER: 0 or 1', assists_complete: 'INTEGER: 0 or 1',
    },
  },
};

function canonicalSeason(value) {
  if (typeof value !== 'string' || value.length > 20) throw new InputError('Each season must be a short season label.');
  const season = value.replace(/\s/g, '').replace(/[–/]/g, '-').replace(/^(20\d{2})-(\d{2})$/, '$1-20$2');
  if (!getSnapshot().seasons.includes(season)) throw new InputError(`Choose an available season: ${getSnapshot().seasons.join(', ')}.`);
  return season;
}

function selectedSeasons(context) {
  if (context.seasons !== undefined) {
    const maximum = getSnapshot().seasons.length;
    if (!Array.isArray(context.seasons) || context.seasons.length < 1 || context.seasons.length > maximum) throw new InputError(`Select between one and ${maximum} available seasons.`);
    const seasons = context.seasons.map(canonicalSeason);
    if (new Set(seasons).size !== seasons.length) throw new InputError('Select each season only once.');
    if (context.season !== undefined && (seasons.length !== 1 || canonicalSeason(context.season) !== seasons[0])) {
      throw new InputError('The single-season and multiple-season selections conflict. Send one season selection.');
    }
    return seasons.sort();
  }
  return [canonicalSeason(context.season === undefined || context.season === '' ? '2025-2026' : context.season)];
}

function selectedEntity(value, kind) {
  if (value === undefined) return 'all';
  if (typeof value !== 'string' || value.length > 180) throw new InputError(`The ${kind} selection must be a short name or ID.`);
  if (allValues.has(normalized(value))) return 'all';
  const requested = kind === 'competition' ? competitionAliases[normalized(value)] || value : value;
  const items = kind === 'competition' ? getSnapshot().competitions : getSnapshot().teams;
  const entity = items.find(item => item.id === requested || normalized(item.name) === normalized(requested)
    || (item.aliases ?? []).some(alias => normalized(alias) === normalized(requested)));
  if (!entity) throw new InputError(`The selected ${kind} is not in this synthetic snapshot.`);
  return entity.id;
}

function scopeFromContext(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new InputError('Context must be an object.');
  if (Object.keys(context).some(key => !['season', 'seasons', 'competition', 'team'].includes(key))) {
    throw new InputError('Analytical context supports season or seasons, competition and team selections.');
  }
  return { seasons: selectedSeasons(context), competition: selectedEntity(context.competition, 'competition'), team: selectedEntity(context.team, 'team') };
}

function validatedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).sort().join(',') !== 'competition,seasons,team') {
    throw new InputError('Provide the validated season, competition and team scope.');
  }
  if (!['all', ...getSnapshot().competitions.map(item => item.id)].includes(scope.competition)
    || !['all', ...getSnapshot().teams.map(item => item.id)].includes(scope.team)) throw new InputError('Analytical scope must contain selected IDs or all.');
  return { seasons: selectedSeasons({ seasons: scope.seasons }), competition: scope.competition, team: scope.team };
}

/** Validates explicit controls only. Question text cannot expand or replace the selected scope. */
export function validateAnalystRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.question !== 'string' || !body.question.trim()
    || body.question.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.question)) throw new InputError('Provide a question between 1 and 1,000 characters.');
  return { question: body.question.trim(), scope: scopeFromContext(body.context) };
}

function inScope(row, scope, includeTeam = true) {
  return scope.seasons.includes(row.season) && (scope.competition === 'all' || row.competitionId === scope.competition)
    && (!includeTeam || scope.team === 'all' || row.teamId === scope.team);
}

export function analystCatalog(context = {}) {
  const scope = scopeFromContext(context);
  const eligible = getSnapshot().playerGroups.filter(row => inScope(row, scope, false) && row.appearances > 0);
  const teamIds = new Set(eligible.map(row => row.teamId));
  const players = new Map();
  for (const row of eligible.filter(row => scope.team === 'all' || row.teamId === scope.team)) {
    const player = players.get(row.playerId) || { id: row.playerId, name: row.player, clubs: new Set() };
    player.clubs.add(row.team); players.set(row.playerId, player);
  }
  return { seasons: [...getSnapshot().seasons], competitions: getSnapshot().competitions.map(item => ({ ...item })),
    teams: getSnapshot().teams.filter(item => teamIds.has(item.id)).map(({ id, name }) => ({ id, name })),
    players: [...players.values()].map(item => ({ id: item.id, name: item.name, club: [...item.clubs].sort().join(', ') })).sort((a, b) => a.name.localeCompare(b.name)),
    mode: 'synthetic-demo' };
}

function scopedGroups(scope) {
  return { players: getSnapshot().playerGroups.filter(row => inScope(row, scope)), teams: getSnapshot().teamGroups.filter(row => inScope(row, scope)) };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Dimension rows are scoped before they reach SQL; their actual source columns remain intact. */
function scopedDimensions(scope, players, teams) {
  const snapshot = getSnapshot(), supplied = snapshot.sourceTables;
  if (!supplied) return {};
  const dimensions = {};
  const playerIds = new Set(players.filter(row => row.appearances > 0).map(row => String(row.playerId)));
  const editionKeys = new Set([...players, ...teams].map(row => `${row.season}\u0000${row.competitionId}`));
  if (supplied.dim_player) dimensions.dim_player = { columns: { ...supplied.dim_player.columns },
    rows: supplied.dim_player.rows.filter(row => playerIds.has(String(row.player_id))).map(row => ({ ...row })) };
  if (supplied.dim_edition) {
    if (Object.hasOwn(supplied.dim_edition.columns, 'age_as_of_date')) throw new InputError('The source edition schema conflicts with the computed age reference date.');
    const rows = supplied.dim_edition.rows.filter(row => scope.seasons.includes(row.season)
      && (scope.competition === 'all' || String(row.competition_id) === scope.competition)
      && (scope.team === 'all' || editionKeys.has(`${row.season}\u0000${row.competition_id}`))).map(row => {
      if (!validDate(row.end_date) || !validDate(snapshot.provenance.snapshotDate) || !['COMPLETE', 'PARTIAL', 'UPCOMING'].includes(row.status)) {
        throw new InputError('Edition dates or status are invalid; an age reference date cannot be calculated reliably.');
      }
      return { ...row, age_as_of_date: row.status === 'COMPLETE' ? row.end_date : [row.end_date, snapshot.provenance.snapshotDate].sort()[0] };
    });
    dimensions.dim_edition = { columns: { ...supplied.dim_edition.columns, age_as_of_date: 'TEXT' }, rows };
  }
  return dimensions;
}

/** Bounded schema, provenance and coverage metadata. No unscoped rows or full match lists. */
export function describeScope(inputScope) {
  const scope = validatedScope(inputScope);
  const { players, teams } = scopedGroups(scope);
  const dimensions = scopedDimensions(scope, players, teams);
  const tables = structuredClone(schemas);
  for (const [name, table] of Object.entries(dimensions)) tables[name] = {
    grain: name === 'dim_player' ? 'One recorded player profile; only players with actual appearances in the selected scope.'
      : 'One competition edition per season and competition; join on BOTH season and competition_id.',
    columns: { ...table.columns },
  };
  const relationships = [
    { from: 'player_stats', columns: ['player_id'], to: 'dim_player', referencedColumns: ['player_id'], cardinality: 'many-to-one' },
    { from: 'player_stats', columns: ['season', 'competition_id'], to: 'dim_edition', referencedColumns: ['season', 'competition_id'], cardinality: 'many-to-one' },
    { from: 'team_stats', columns: ['season', 'competition_id'], to: 'dim_edition', referencedColumns: ['season', 'competition_id'], cardinality: 'many-to-one' },
  ].filter(item => tables[item.to]);
  const matchIds = [...new Set(teams.flatMap(row => row.matchIds))].sort();
  return { scope, labels: { seasons: scope.seasons,
    competition: scope.competition === 'all' ? 'All competitions' : competitionById().get(scope.competition).name,
    team: scope.team === 'all' ? 'All clubs' : getSnapshot().teams.find(item => item.id === scope.team).name },
    tables, relationships, sourceVersion: getSnapshot().sourceVersion,
    functions: { age_on: { signature: 'age_on(birth_date, reference_date)',
      arguments: ['ISO YYYY-MM-DD birth date', 'ISO YYYY-MM-DD reference date'],
      returns: 'INTEGER completed calendar years; NULL for missing/invalid dates or a reference before birth.',
      leapDayRule: 'A February 29 birth reaches the next completed year on March 1 in non-leap years.' } },
    sourceCatalog: { ...structuredClone(getSnapshot().sourceCatalog || { tables: [] }), queryRelationships: relationships },
    editions: getSnapshot().editions.filter(edition => scope.seasons.includes(edition.season)
      && (scope.competition === 'all' || edition.competitionId === scope.competition)).map(edition => ({ ...edition })),
    editionStatusSource: { ...getSnapshot().provenance.sources.find(source => source.path.endsWith('/dim_edition.csv')) },
    provenance: structuredClone(getSnapshot().provenance),
    coverage: { playerAggregateRows: players.length, teamAggregateRows: teams.length, players: new Set(players.map(row => row.playerId)).size,
      teams: new Set(teams.map(row => row.teamId)).size, distinctMatches: matchIds.length, matchIds: matchIds.slice(0, 12), matchIdsTruncated: matchIds.length > 12,
      playerGoalsComplete: players.every(row => completeFlag(row, 'goalsComplete', ['goals']) === 1), playerAssistsComplete: players.every(row => completeFlag(row, 'assistsComplete', ['assists']) === 1),
      playerCardsComplete: players.every(row => completeFlag(row, 'cardsComplete', ['yellowCards', 'redCards']) === 1), teamGoalsComplete: teams.every(row => completeFlag(row, 'goalsComplete', ['goalsFor', 'goalsAgainst']) === 1),
      teamAssistsComplete: teams.every(row => completeFlag(row, 'assistsComplete', ['assists']) === 1),
      incompletePlayerRows: { goals: players.filter(row => completeFlag(row, 'goalsComplete', ['goals']) === 0).length, assists: players.filter(row => completeFlag(row, 'assistsComplete', ['assists']) === 0).length, cards: players.filter(row => completeFlag(row, 'cardsComplete', ['yellowCards', 'redCards']) === 0).length },
      incompleteTeamRows: { goals: teams.filter(row => completeFlag(row, 'goalsComplete', ['goalsFor', 'goalsAgainst']) === 0).length, assists: teams.filter(row => completeFlag(row, 'assistsComplete', ['assists']) === 0).length } },
    rules: [
      'The database contains only the explicitly selected seasons, competition and club. SQL cannot reach rows outside that scope.',
      'Only the listed queryable SQL tables exist. Other discovered CSV tables and their exact columns are metadata-only until a scoped query adapter is implemented; do not pretend to query them.',
      'Player profile columns come directly from dim_player. Join player_stats.player_id to dim_player.player_id after aggregating the requested player facts. Date of birth is fictional_birth_date, not a precomputed age.',
      'dim_edition joins require BOTH season and competition_id. age_as_of_date is the edition end_date for COMPLETE editions, otherwise the earlier of end_date and the snapshot date. Use age_on(dim_player.fictional_birth_date, dim_edition.age_as_of_date) for exact completed-year age; never divide Julian-day differences by 365 or 365.25. Display the reference date; multiple seasons may give several ages, so do not silently call one the current age.',
      'Edition status comes from the trusted editions metadata: COMPLETE means the competition edition is complete; PARTIAL means in progress at the snapshot; UPCOMING means not yet started. Do not infer season completion from goals, appearances, the current date or metric-feed completeness. Different competitions in the same season can have different edition status.',
      'A player can have multiple rows across teams, seasons and competitions. Aggregate by player_id plus requested grouping dimensions before ranking.',
      'Incomplete metrics are NULL, not zero. SUM and AVG ignore NULL and can produce partial totals: check MIN(metric_complete)=1 before reporting complete aggregates. Goal contributions require both goals_complete and assists_complete.',
      'Calculate per-appearance output as 1.0 * SUM(metric) / NULLIF(SUM(appearances), 0), not an average of row rates. No played-minutes field exists, so per-90 statistics are unavailable.',
      'Player goals exclude own goals credited to the opponent. Team goals_for includes goals benefiting the team, including own goals; SUM(player goals) is not necessarily team goals_for.',
      'Do not directly join player_stats to team_stats and sum team metrics: team aggregate rows repeat per player. Aggregate each side to compatible keys first.',
      'SUM(team_stats.played) counts team appearances in matches and can double-count matches when both teams are selected. coverage.distinctMatches is the distinct match count for the full selected scope.',
      'Categories and age groups describe competition classification, taken from source metadata, not inferred from player names.',
      'Each result is limited to 200 rows and 256 KiB. rowCount means returned rows; truncated means more result data was omitted.',
    ] };
}

function categoryMetadata(row) {
  const item = competitionById().get(row.competitionId);
  if (!item || !['MEN', 'WOMEN'].includes(item.category) || !['SENIOR', 'U19'].includes(item.ageGroup)) throw new InputError('Competition classification metadata is incomplete.');
  return { category: item.category, age_group: item.ageGroup };
}

const completeMetric = (row, field, flag) => row[flag] === true && Number.isInteger(row[field]) && row[field] >= 0 ? row[field] : null;
const completeFlag = (row, flag, fields) => Number(row[flag] === true && fields.every(field => Number.isInteger(row[field]) && row[field] >= 0));

function queryPayload(scope, sql) {
  const { players, teams } = scopedGroups(scope);
  return { sql, sourceTables: scopedDimensions(scope, players, teams),
    playerRows: players.map(row => ({ player_id: row.playerId, player: row.player, team_id: row.teamId, team: row.team, season: row.season,
      competition_id: row.competitionId, competition: row.competition, ...categoryMetadata(row), appearances: row.appearances,
      goals: completeMetric(row, 'goals', 'goalsComplete'), assists: completeMetric(row, 'assists', 'assistsComplete'),
      yellow_cards: completeMetric(row, 'yellowCards', 'cardsComplete'), red_cards: completeMetric(row, 'redCards', 'cardsComplete'),
      goals_complete: completeFlag(row, 'goalsComplete', ['goals']), assists_complete: completeFlag(row, 'assistsComplete', ['assists']), cards_complete: completeFlag(row, 'cardsComplete', ['yellowCards', 'redCards']) })),
    teamRows: teams.map(row => ({ team_id: row.teamId, team: row.team, season: row.season, competition_id: row.competitionId, competition: row.competition,
      ...categoryMetadata(row), played: row.played, goals_for: completeMetric(row, 'goalsFor', 'goalsComplete'), goals_against: completeMetric(row, 'goalsAgainst', 'goalsComplete'),
      assists: completeMetric(row, 'assists', 'assistsComplete'), wins: row.wins, draws: row.draws, losses: row.losses,
      goals_complete: completeFlag(row, 'goalsComplete', ['goalsFor', 'goalsAgainst']), assists_complete: completeFlag(row, 'assistsComplete', ['assists']) })) };
}

/** Executes one bounded read-only SELECT against an ephemeral, already-filtered database. */
export async function querySnapshot(inputScope, sql, { signal } = {}) {
  const scope = validatedScope(inputScope);
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql, 'utf8') > maximumSqlBytes) throw new InputError('Provide one read-only SQL query of at most 8 KiB.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new InputError('The cancellation signal is invalid.');
  if (signal?.aborted) throw new DOMException('The query was cancelled.', 'AbortError');
  const payload = JSON.stringify(queryPayload(scope, sql));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FRMF_SQLITE_PYTHON || 'python3', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0; let settled = false; let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error && child.exitCode === null) child.kill('SIGKILL');
      if (error) reject(error); else resolve({ ...result, elapsedMs: Math.round(performance.now() - started) });
    };
    const abort = () => finish(new DOMException('The query was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => finish(new InputError('The query exceeded its 3-second limit. Add filters or simplify the calculation.')), 3500);
    child.on('error', () => finish(new InputError('The local SQLite worker could not start. Check the configured Python installation.')));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(new InputError('The local SQLite worker could not receive the selected data.')); });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maximumResultBytes) finish(new InputError('The query result exceeded 256 KiB. Select fewer or smaller columns.'));
      else chunks.push(chunk);
    });
    // Drain diagnostics, but never return interpreter paths or raw request contents to the client.
    child.stderr.resume();
    child.on('close', code => {
      if (settled) return;
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { finish(new InputError('The local SQLite worker returned an unreadable result.')); return; }
      if (code !== 0 || result.error) { finish(new InputError(result.error || 'The query could not be completed.')); return; }
      if (!Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length > 200 || result.rowCount !== result.rows.length || typeof result.truncated !== 'boolean') {
        finish(new InputError('The local SQLite worker returned an invalid result.')); return;
      }
      finish(null, { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated });
    });
    child.stdin.end(payload);
  });
}
