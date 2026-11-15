import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(readFileSync(new URL('./synthetic-snapshot.json', import.meta.url), 'utf8'));
if (snapshot.provenance.isSynthetic !== true) throw new Error('Only the synthetic pilot snapshot is supported.');

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const isAll = value => !value || ['all', 'all competitions', 'all teams', 'all players', 'tous', 'toutes'].includes(normalize(value));
const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
const completeTotal = (rows, field, flag) => rows.every(row => row[flag]) ? total(rows, field) : null;
const aliases = { 'botola': 'Botola Pro D1', 'botola men': 'Botola Pro D1', 'coupe du trone': 'Coupe du Trône', 'u19 women': 'Championnat National U19 Féminin', 'u19 men': 'Championnat National U19 Masculin', 'women': 'Championnat Féminin D1' };

export class InputError extends Error {}

function matchEntity(value, options) {
  const key = normalize(value);
  return options.find(item => item.id === value || normalize(item.name) === key || (item.aliases ?? []).some(alias => normalize(alias) === key));
}

function mention(question, options) {
  const q = ` ${normalize(question)} `;
  const found = options.filter(item => [item.name, ...(item.aliases ?? [])].some(alias => q.includes(` ${normalize(alias)} `)));
  // Prefer the most specific entity, e.g. AS FAR Women U19 over AS FAR.
  return found.sort((a, b) => b.name.length - a.name.length)[0];
}

function scopeFromContext(context = {}, question = '') {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new InputError('Context must be an object.');
  for (const [key, value] of Object.entries(context)) {
    if (!['season', 'competition', 'team', 'player'].includes(key) || typeof value !== 'string' || value.length > 180) {
      throw new InputError('Context supports season, competition, team and player as short strings.');
    }
  }
  const scope = {};
  const seasonInQuestion = question.match(/20\d{2}\s*[-/–]\s*(?:20)?\d{2}/)?.[0];
  let season = context.season || seasonInQuestion || '2025-2026';
  const seasonParts = season.replace(/\s/g, '').replace(/[–/]/g, '-').split('-');
  if (seasonParts.length === 2 && seasonParts[1].length === 2) seasonParts[1] = `20${seasonParts[1]}`;
  season = seasonParts.join('-');
  if (!snapshot.seasons.includes(season)) throw new InputError(`Choose one available season: ${snapshot.seasons.join(', ')}.`);
  scope.season = season;
  for (const [kind, items] of [['competition', snapshot.competitions], ['team', snapshot.teams], ['player', snapshot.players]]) {
    const value = context[kind];
    let entity;
    if (!isAll(value)) {
      entity = matchEntity(kind === 'competition' ? aliases[normalize(value)] || value : value, items);
      if (!entity) throw new InputError(`The selected ${kind} is not in the synthetic pilot snapshot.`);
    } else if (kind !== 'competition' || !value) {
      entity = mention(question, items);
      if (!entity && kind === 'competition') {
        // Category and age words are filters, not inferred competition identities.
        const alias = Object.keys(aliases).filter(name => !['women', 'u19 women', 'u19 men'].includes(name)).sort((a, b) => b.length - a.length).find(name => ` ${normalize(question)} `.includes(` ${name} `));
        if (alias) entity = matchEntity(aliases[alias], items);
      }
    }
    if (entity) { scope[kind] = entity.name; scope[`${kind}Id`] = entity.id; }
  }
  return scope;
}

function filterRows(rows, scope) {
  return rows.filter(row => row.season === scope.season && (!scope.competitionId || row.competitionId === scope.competitionId)
    && (!scope.teamId || row.teamId === scope.teamId) && (!scope.playerId || row.playerId === scope.playerId));
}

function response(answer, rows, scope, sourceRows = []) {
  const matchIds = [...new Set(sourceRows.flatMap(row => row.matchIds))].sort();
  return { answer, rows, evidence: { source: snapshot.provenance.dataset, scope,
    updatedAt: snapshot.provenance.snapshotDate, isSynthetic: true, matchCount: matchIds.length,
    matchIds: matchIds.slice(0, 12), matchIdsTruncated: matchIds.length > 12 }, mode: 'deterministic-demo' };
}

const display = value => value === null ? 'not available (incomplete feed)' : value;
const scopeLabel = scope => `${scope.season} · ${scope.competition || 'all competitions'}${scope.team ? ` · ${scope.team}` : ''}`;

const rankingMetrics = ['goals', 'assists', 'goalContributions'];
const metricLabels = { goals: 'goals', assists: 'assists', goalContributions: 'goals + assists' };

function rankingOptions(plan = {}, rankingBasis) {
  const metric = plan.metric ?? 'goals';
  if (!rankingMetrics.includes(metric)) throw new InputError('The model returned an unsupported metric.');
  if (plan.basis !== undefined && !['total', 'perAppearance', 'clarify'].includes(plan.basis)) throw new InputError('Choose total contributions or contributions per appearance.');
  if (plan.minimumAppearances !== undefined && (!Number.isInteger(plan.minimumAppearances) || plan.minimumAppearances < 0 || plan.minimumAppearances > 1000)) {
    throw new InputError('Minimum appearances must be a whole number between 0 and 1,000.');
  }
  if (plan.requireBoth !== undefined && typeof plan.requireBoth !== 'boolean') throw new InputError('The goals-and-assists eligibility choice must be true or false.');
  if (rankingBasis !== undefined && !['total', 'perAppearance'].includes(rankingBasis)) throw new InputError('Choose total or perAppearance as the ranking basis.');
  if (plan.groupBy !== undefined && !['none', 'category', 'competition', 'team'].includes(plan.groupBy)) throw new InputError('Choose an available player-ranking grouping.');
  if (plan.limit !== undefined && (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 10)) throw new InputError('Choose between 1 and 10 players per group.');
  if (plan.categories !== undefined && (!Array.isArray(plan.categories) || plan.categories.some(category => !['MEN', 'WOMEN'].includes(category))
    || new Set(plan.categories).size !== plan.categories.length)) throw new InputError('Categories must be a unique selection of MEN and WOMEN.');
  if (plan.ageGroup !== undefined && !['ALL', 'SENIOR', 'U19'].includes(plan.ageGroup)) throw new InputError('Choose ALL, SENIOR or U19 as the age group.');
  const basis = rankingBasis ?? plan.basis ?? 'total';
  return { metric, basis, minimumAppearances: plan.minimumAppearances || (basis === 'perAppearance' ? 10 : 1), requireBoth: plan.requireBoth ?? false,
    groupBy: plan.groupBy ?? 'none', limit: plan.limit ?? 10, categories: ['MEN', 'WOMEN'].filter(category => plan.categories?.includes(category)), ageGroup: plan.ageGroup ?? 'ALL' };
}

/** Computes rankings from disjoint appearance aggregates; never averages group rates. */
export function calculatePlayerRanking(source, plan = {}) {
  const options = rankingOptions(plan);
  const { metric, basis, minimumAppearances, requireBoth } = options;
  if (basis === 'clarify') throw new InputError('Choose a ranking basis before calculating a leaderboard.');
  const required = metric === 'goalContributions' || requireBoth ? ['goals', 'assists'] : [metric];
  const missingMetrics = required.filter(field => !source.every(row => row[`${field}Complete`] === true));
  if (missingMetrics.length) return { ...options, rows: [], eligiblePlayers: null, missingMetrics };
  const grouped = new Map();
  for (const row of source) {
    if (!Number.isInteger(row.appearances) || row.appearances < 0 || !Array.isArray(row.matchIds) || row.matchIds.length !== row.appearances
      || required.some(field => !Number.isInteger(row[field]) || row[field] < 0)) {
      throw new InputError('The selected appearance aggregates are inconsistent; this ranking cannot be calculated reliably.');
    }
    const item = grouped.get(row.playerId) || { player: row.player, clubs: new Set(), matchIds: new Set(), appearances: 0,
      goals: 0, assists: 0, goalsComplete: true, assistsComplete: true };
    for (const matchId of row.matchIds) {
      if (item.matchIds.has(matchId)) throw new InputError('The selected appearance aggregates overlap; this ranking cannot be calculated reliably.');
      item.matchIds.add(matchId);
    }
    item.clubs.add(row.team); item.appearances += row.appearances;
    for (const field of ['goals', 'assists']) {
      item[`${field}Complete`] &&= row[`${field}Complete`] === true && Number.isInteger(row[field]) && row[field] >= 0;
      if (item[`${field}Complete`]) item[field] += row[field];
    }
    grouped.set(row.playerId, item);
  }
  const eligible = [...grouped.values()].filter(row => row.appearances >= minimumAppearances && (!requireBoth || row.goals > 0 && row.assists > 0)).map(row => {
    const goals = row.goalsComplete ? row.goals : null;
    const assists = row.assistsComplete ? row.assists : null;
    const result = { player: row.player, club: [...row.clubs].sort().join(', '), appearances: row.appearances,
      goals, assists, goalContributions: goals !== null && assists !== null ? goals + assists : null };
    if (basis === 'perAppearance') result.perAppearance = result[metric] / result.appearances;
    return result;
  });
  const value = basis === 'perAppearance' ? 'perAppearance' : metric;
  eligible.sort((a, b) => b[value] - a[value] || a.player.localeCompare(b.player));
  return { ...options, rows: eligible.slice(0, options.limit), eligiblePlayers: eligible.length, missingMetrics: [] };
}

const categoryLabels = { MEN: "Men's competitions", WOMEN: "Women's competitions" };

/** Filters dimensions from source metadata, then ranks players independently within each group. */
export function calculateGroupedPlayerRanking(source, plan = {}, competitions = snapshot.competitions) {
  const options = rankingOptions(plan);
  const metadata = new Map(competitions.map(item => [item.id, item]));
  const enriched = source.map(row => {
    const competition = metadata.get(row.competitionId);
    if (!competition || !['MEN', 'WOMEN'].includes(competition.category) || !['SENIOR', 'U19'].includes(competition.ageGroup)) {
      throw new InputError('Competition category or age-group metadata is missing; this ranking cannot be filtered reliably.');
    }
    return { ...row, category: competition.category, ageGroup: competition.ageGroup };
  });
  const selected = enriched.filter(row => (!options.categories.length || options.categories.includes(row.category))
    && (options.ageGroup === 'ALL' || row.ageGroup === options.ageGroup));
  const categoryCoverage = options.categories.map(category => {
    const rows = selected.filter(row => row.category === category);
    return { category, group: categoryLabels[category], sourceCount: rows.length,
      ...(rows.length ? {} : { reason: 'No recorded appearances in this category within the selected season, competition, club and age group.' }) };
  });
  const buckets = new Map();
  if (options.groupBy === 'none') buckets.set('all', { label: 'Selected players', source: selected });
  else if (options.groupBy === 'category') {
    const categories = options.categories.length ? options.categories : ['MEN', 'WOMEN'].filter(category => enriched.some(row => row.category === category));
    for (const category of categories) buckets.set(category, { label: categoryLabels[category], source: selected.filter(row => row.category === category) });
  } else {
    const idKey = options.groupBy === 'competition' ? 'competitionId' : 'teamId';
    for (const row of selected) {
      const item = buckets.get(row[idKey]) || { label: row[options.groupBy], source: [] };
      item.source.push(row); buckets.set(row[idKey], item);
    }
  }
  const groups = [...buckets.entries()].map(([id, bucket]) => {
    const ranking = calculatePlayerRanking(bucket.source, options);
    const status = !bucket.source.length ? 'no_appearances' : ranking.missingMetrics.length ? 'incomplete' : !ranking.rows.length ? 'no_eligible_players' : 'available';
    const reasons = { no_appearances: 'No recorded appearances within the selected scope.',
      incomplete: `Incomplete ${ranking.missingMetrics.join(' and ')} feed; missing records are not zero.`,
      no_eligible_players: 'No players meet the minimum appearances and scoring requirements.' };
    return { id, group: bucket.label, status, sourceCount: bucket.source.length,
      matchCount: new Set(bucket.source.flatMap(row => row.matchIds)).size,
      eligiblePlayers: ranking.eligiblePlayers, missingMetrics: ranking.missingMetrics,
      ...(reasons[status] ? { reason: reasons[status] } : {}), rows: ranking.rows };
  });
  if (options.groupBy === 'competition' || options.groupBy === 'team') groups.sort((a, b) => a.group.localeCompare(b.group));
  return { ...options, source: selected, categoryCoverage, groups,
    rows: groups.flatMap(group => group.rows.map((row, index) => options.groupBy === 'none' ? row : { group: group.group, rank: index + 1, ...row })) };
}

function leaderboard(plan, body, scope, onProgress) {
  const options = rankingOptions(plan, body.rankingBasis);
  const { metric, basis, minimumAppearances, requireBoth, groupBy, limit, categories, ageGroup } = options;
  if (scope.playerId) return response('A player is selected. Clear the player selection before requesting a leaderboard for all eligible players.', [], scope);
  const ageLabel = ageGroup === 'ALL' ? 'Senior and U19 competitions are included where available' : `${ageGroup === 'U19' ? 'U19' : 'Senior'} competitions only`;
  const categoryLabel = categories.length ? categories.map(category => categoryLabels[category]).join(' and ') : 'All selected competition categories';
  if (basis === 'clarify') {
    const label = metricLabels[metric];
    const rateMinimum = plan.minimumAppearances || 10;
    const result = response(`How should I rank players: by total ${label}, or ${label} per appearance? The per-appearance option requires at least ${rateMinimum} appearance${rateMinimum === 1 ? '' : 's'}.${requireBoth ? ' Players must have at least one goal and one assist.' : ''} ${categoryLabel}. ${ageLabel}.${groupBy !== 'none' ? ` Separate rankings by ${groupBy}, up to ${limit} players each.` : ''}`, [], scope);
    result.clarification = { field: 'rankingBasis', options: [
      { label: metric === 'goalContributions' ? 'Total contributions' : `Total ${label}`, value: 'total' },
      { label: `Per appearance · minimum ${rateMinimum} appearance${rateMinimum === 1 ? '' : 's'}`, value: 'perAppearance' },
    ] };
    result.evidence.ranking = { ...options };
    return result;
  }
  const source = filterRows(snapshot.playerGroups, scope);
  onProgress?.('calculating');
  const ranking = calculateGroupedPlayerRanking(source, options);
  const shortMetric = metric === 'goalContributions' ? 'G+A' : metricLabels[metric];
  const formula = basis === 'perAppearance' ? `${metric === 'goalContributions' ? '(G+A)' : shortMetric} / appearances` : shortMetric;
  const eligibility = `At least ${minimumAppearances} appearance${minimumAppearances === 1 ? '' : 's'}${requireBoth ? ', with at least one goal and one assist' : ''}`;
  const tiePolicy = `Equal values use alphabetical order; the list is capped at ${limit} player${limit === 1 ? '' : 's'}${groupBy === 'none' ? '' : ' per group'}, including at the cutoff.`;
  const title = metric === 'goalContributions' ? 'Goal contributions' : metric === 'assists' ? 'Top assist providers' : 'Top scorers';
  const explainedGroups = ranking.groups.length <= 3 ? ranking.groups : ranking.groups.filter(group => group.status !== 'available');
  const details = explainedGroups.map(group => {
    const prefix = groupBy === 'none' ? '' : `${group.group}: `;
    if (group.reason) return `${prefix}${group.reason}`;
    const leader = group.rows[0];
    const value = basis === 'perAppearance' ? `${leader.perAppearance.toFixed(3)} ${shortMetric} per appearance` : `${leader[metric]} ${shortMetric}`;
    return `${prefix}${leader.player} is first with ${value}. Showing ${group.rows.length} of ${group.eligiblePlayers} eligible players.`;
  });
  if (ranking.groups.length > 3) details.unshift(`Showing ${ranking.rows.length} players across ${ranking.groups.filter(group => group.status === 'available').length} available ${groupBy} groups.`);
  if (!ranking.groups.length) details.push('No recorded appearances are available for these filters.');
  if (groupBy !== 'category') details.push(...ranking.categoryCoverage.filter(item => item.reason).map(item => `${item.group}: ${item.reason}`));
  const answer = `${title} · ${scopeLabel(scope)}. ${details.join(' ')} Formula: ${formula}. ${eligibility}. ${categories.length ? `${categoryLabel}. ` : ''}${ageLabel}. ${tiePolicy}`;
  const result = response(answer, ranking.rows, scope, ranking.source);
  result.evidence.ranking = { metric, basis, formula, minimumAppearances, requireBoth, groupBy, categories, ageGroup,
    eligiblePlayers: ranking.groups.some(group => group.eligiblePlayers === null) ? null : ranking.groups.reduce((sum, group) => sum + group.eligiblePlayers, 0),
    missingMetrics: [...new Set(ranking.groups.flatMap(group => group.missingMetrics))], limit, tiePolicy,
    categoryCoverage: ranking.categoryCoverage, groups: ranking.groups.map(({ rows, ...group }) => ({ ...group, displayedPlayers: rows.length })) };
  return result;
}

/** Pure request validation and empty source evidence; never calculates statistics. */
export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000) {
    throw new InputError('Provide a question between 1 and 1,000 characters.');
  }
  if (body.rankingBasis !== undefined && !['total', 'perAppearance'].includes(body.rankingBasis)) throw new InputError('Choose total or perAppearance as the ranking basis.');
  const scope = scopeFromContext(body.context, body.question);
  return { scope, evidence: response('', [], scope).evidence };
}

export function chat(body) {
  const { scope } = validateRequest(body);
  const question = body.question.trim();
  const q = normalize(question);
  const conflict = questionConflict(body, scope);
  if (conflict) return response(conflict, [], scope);
  if (/\b(compare|comparison|versus|vs|pourquoi|why|predict|prediction|forecast)\b/.test(q)) {
    return response('This connection pilot supports player totals, team totals, top scorers and top assist providers. Comparisons and open-ended analysis need the next assistant stage.', [], scope);
  }
  const ranking = /\b(top|leader|leaders|scorer|scorers|buteur|buteurs|passeur|passeurs|classement)\b/.test(q);
  if (ranking) {
    if (scope.playerId) return response('A player is selected. Clear the player selection before requesting a leaderboard for all eligible players.', [], scope);
    const metric = /\b(assist|assists|assistance|assists?|passeur|passeurs|decisives)\b/.test(q) ? 'assists' : 'goals';
    return leaderboard({ metric }, body, scope);
  }
  const supported = /\b(total|totals|stat|stats|statistics|statistiques|goal|goals|assist|assists|appearance|appearances|played|match|matches|buts|bilan|show|montre|combien|how many)\b/.test(q);
  if (supported && scope.playerId) {
    const source = filterRows(snapshot.playerGroups, scope);
    if (!source.length) return response(`${scope.player} has no recorded appearance in ${scopeLabel(scope)}. No totals are fabricated for an unplayed scope.`, [], scope);
    const row = { player: scope.player, clubs: [...new Set(source.map(item => item.team))].join(', '), appearances: total(source, 'appearances'),
      goals: completeTotal(source, 'goals', 'goalsComplete'), assists: completeTotal(source, 'assists', 'assistsComplete'),
      yellowCards: completeTotal(source, 'yellowCards', 'cardsComplete'), redCards: completeTotal(source, 'redCards', 'cardsComplete') };
    return response(`${row.player} · ${scopeLabel(scope)}: ${row.appearances} appearances, ${display(row.goals)} goals and ${display(row.assists)} primary assists.`, [row], scope, source);
  }
  if (supported && scope.teamId) {
    const source = filterRows(snapshot.teamGroups, scope);
    if (!source.length) return response(`${scope.team} has no played match in ${scopeLabel(scope)}. Choose another selection.`, [], scope);
    const row = { team: scope.team, played: total(source, 'played'), goalsFor: completeTotal(source, 'goalsFor', 'goalsComplete'),
      assists: completeTotal(source, 'assists', 'assistsComplete'), goalsAgainst: completeTotal(source, 'goalsAgainst', 'goalsComplete'),
      wins: total(source, 'wins'), draws: total(source, 'draws'), losses: total(source, 'losses') };
    row.winRate = `${(100 * row.wins / row.played).toFixed(1)}%`;
    return response(`${row.team} · ${scopeLabel(scope)}: ${row.played} matches, ${display(row.goalsFor)} goals for, ${display(row.assists)} primary assists and ${display(row.goalsAgainst)} goals against. Win rate: ${row.winRate}.`, [row], scope, source);
  }
  return response('Choose a player or team and ask for its totals, or ask “Show top scorers” / “Show top assist providers”. This pilot uses verified synthetic statistics and fixed operations; no language model is connected yet.', [], scope);
}

function questionConflict(body, scope) {
  for (const [kind, items] of [['competition', snapshot.competitions], ['team', snapshot.teams], ['player', snapshot.players]]) {
    const explicit = mention(body.question, items);
    if (!isAll(body.context?.[kind]) && explicit && scope[`${kind}Id`] !== explicit.id) {
      return `Your selected ${kind} is ${scope[kind]}, but the question names ${explicit.name}. Change the selection or revise the question so the scope is clear.`;
    }
  }
  const seasonMention = body.question.match(/20\d{2}\s*[-/–]\s*(?:20)?\d{2}/)?.[0];
  if (body.context?.season && seasonMention) {
    const inferred = scopeFromContext({ season: seasonMention });
    if (inferred.season !== scope.season) return `The selected season is ${scope.season}, but the question asks for ${inferred.season}. Change the season selection or revise the question.`;
  }
  return null;
}

export function executePlan(plan, body, { onProgress } = {}) {
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new InputError('The progress callback must be a function.');
  onProgress?.('checking');
  const { scope: selected } = validateRequest(body);
  const originalConflict = questionConflict(body, selected);
  if (originalConflict) return response(originalConflict, [], selected);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new InputError('The model returned an invalid operation.');
  const allowed = ['player_totals', 'team_totals', 'leaderboard', 'unsupported'];
  if (!allowed.includes(plan.operation)) throw new InputError('The model requested an unsupported operation.');
  if (Object.keys(plan).some(key => !['operation', 'metric', 'player', 'team', 'season', 'competition', 'basis', 'minimumAppearances', 'requireBoth', 'groupBy', 'limit', 'categories', 'ageGroup'].includes(key))) throw new InputError('The model returned unsupported operation fields.');
  rankingOptions(plan, body.rankingBasis);
  if (plan.operation === 'unsupported') return response('This pilot can retrieve player totals, team totals, top scorers and top assist providers. Please ask one of those statistics questions.', [], selected);
  const proposedContext = Object.fromEntries(['season', 'competition', 'team', 'player'].filter(key => plan[key] !== undefined).map(key => [key, plan[key]]));
  for (const [key, value] of Object.entries(proposedContext)) {
    if (typeof value !== 'string' || value.length > 180) throw new InputError('The model returned invalid selection values.');
  }
  const proposed = scopeFromContext({ ...body.context, ...proposedContext });
  for (const key of ['season', 'competition', 'team', 'player']) {
    const mentioned = key === 'season' ? /20\d{2}\s*[-/–]\s*(?:20)?\d{2}/.test(body.question)
      : Boolean(mention(body.question, snapshot[key === 'competition' ? 'competitions' : key === 'team' ? 'teams' : 'players']));
    if (proposedContext[key] !== undefined && (!isAll(body.context?.[key]) || mentioned) && selected[key] !== proposed[key]) {
      return response(`The question suggests a different ${key} from the current selection. Update the ${key} selector or revise the question; the assistant will keep your selected scope.`, [], selected);
    }
  }
  const context = { ...body.context, ...proposedContext };
  if (plan.operation === 'player_totals' && isAll(context.player)) return response('Which player should I use? Select a player or include their full name.', [], selected);
  if (plan.operation === 'team_totals' && isAll(context.team)) return response('Which team should I use? Select a club or include its name.', [], selected);
  if (plan.operation === 'team_totals') {
    if (!isAll(body.context?.player)) return response('A player is selected. Clear the player selection before requesting whole-team totals.', [], selected);
    delete context.player;
  }
  if (plan.operation === 'leaderboard') return leaderboard(plan, body, scopeFromContext(context, body.question), onProgress);
  onProgress?.('calculating');
  return chat({ question: 'Show totals', context });
}

export function catalog(context = {}) {
  const scope = scopeFromContext(context);
  const scoped = filterRows(snapshot.playerGroups, { ...scope, teamId: undefined, playerId: undefined });
  const teams = snapshot.teams.filter(team => scoped.some(row => row.teamId === team.id)).map(({ id, name }) => ({ id, name }));
  const eligible = new Map();
  for (const row of scoped.filter(row => !scope.teamId || row.teamId === scope.teamId)) {
    const item = eligible.get(row.playerId) || { id: row.playerId, name: row.player, clubs: new Set() };
    item.clubs.add(row.team); eligible.set(row.playerId, item);
  }
  return { seasons: snapshot.seasons, competitions: snapshot.competitions, teams,
    players: [...eligible.values()].map(row => ({ id: row.id, name: row.name, club: [...row.clubs].join(', ') })).sort((a, b) => a.name.localeCompare(b.name)), mode: 'synthetic-demo' };
}
