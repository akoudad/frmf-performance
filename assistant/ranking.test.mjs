import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePlayerRanking, calculateGroupedPlayerRanking, validateRequest, chat, executePlan, InputError } from './engine.mjs';

const context = { season: '2025-2026', competition: 'Botola Pro D1' };
const question = 'show the player that combine high rate of assists and goals same time';
const combined = { operation: 'leaderboard', metric: 'goalContributions', requireBoth: true };
const group = (player, appearances, goals, assists, extra = {}) => ({
  playerId: player, player, team: 'Example Club', appearances, goals, assists,
  goalsComplete: true, assistsComplete: true,
  matchIds: Array.from({ length: appearances }, (_, i) => `${player}-${i}`), ...extra,
});

test('ambiguous combined performance asks for a basis and waits without inventing results', () => {
  const result = executePlan({ ...combined, basis: 'clarify' }, { question, context });
  assert.deepEqual(result.rows, []);
  assert.equal(result.clarification.field, 'rankingBasis');
  assert.deepEqual(result.clarification.options.map(option => option.value), ['total', 'perAppearance']);
  assert.match(result.answer, /total goals \+ assists/);
  assert.match(result.answer, /at least one goal and one assist/);
});

test('user basis choice resolves the same question and computes independently checked Botola totals', () => {
  const result = executePlan({ ...combined, basis: 'clarify' }, { question, context, rankingBasis: 'total' });
  assert.deepEqual(result.rows[0], { player: 'Mohamed Qadiri', club: 'Moghreb Tétouan', appearances: 20,
    goals: 12, assists: 2, goalContributions: 14 });
  assert.equal(result.rows.length, 10);
  assert.equal(result.evidence.ranking.eligiblePlayers, 149);
  assert.equal(result.evidence.ranking.formula, 'G+A');
  assert.equal(result.evidence.scope.competition, context.competition);
  assert.equal(result.evidence.scope.season, context.season);
  assert.equal(result.evidence.matchCount, 240);
});

test('per-appearance result ranks unrounded fractions and exposes the default sample minimum', () => {
  const result = executePlan({ ...combined, basis: 'clarify' }, { question, context, rankingBasis: 'perAppearance' });
  assert.equal(result.rows[0].player, 'Mohamed Qadiri');
  assert.equal(result.rows[0].perAppearance, 14 / 20);
  assert.equal(result.rows[1].player, 'Driss Benbrahim');
  assert.equal(result.rows[1].perAppearance, 13 / 19);
  assert.equal(result.evidence.ranking.minimumAppearances, 10);
  assert.equal(result.evidence.ranking.formula, '(G+A) / appearances');
  assert.match(result.answer, /capped at 10 players/);
});

test('aggregate rates use sum of metrics divided by sum of actual appearances across clubs', () => {
  const source = [group('A', 1, 1, 0), group('A', 9, 0, 1, { team: 'Second Club', matchIds: Array.from({ length: 9 }, (_, i) => `other-${i}`) }), group('B', 10, 2, 2)];
  const result = calculatePlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance' });
  assert.equal(result.rows[0].player, 'B');
  const a = result.rows.find(row => row.player === 'A');
  assert.equal(a.appearances, 10);
  assert.equal(a.goalContributions, 2);
  assert.equal(a.perAppearance, 0.2);
  assert.equal(a.club, 'Example Club, Second Club');
});

test('small samples are excluded by default but a specified minimum is respected', () => {
  const source = [group('Small sample', 1, 4, 1), group('Regular player', 10, 2, 2)];
  const standard = calculatePlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance', minimumAppearances: 0 });
  assert.deepEqual(standard.rows.map(row => row.player), ['Regular player']);
  const explicit = calculatePlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance', minimumAppearances: 1 });
  assert.equal(explicit.rows[0].player, 'Small sample');
  assert.equal(calculatePlayerRanking(source, { metric: 'goalContributions' }).rows[0].player, 'Small sample');
});

test('requireBoth means positive goals and assists, not a claim of balanced ability', () => {
  const source = [group('Only goals', 10, 12, 0), group('Only assists', 10, 0, 14), group('Both', 10, 1, 2)];
  assert.equal(calculatePlayerRanking(source, { metric: 'goalContributions' }).rows.length, 3);
  const result = calculatePlayerRanking(source, { metric: 'goalContributions', requireBoth: true });
  assert.deepEqual(result.rows.map(row => row.player), ['Both']);
});

test('incomplete either feed blocks combined rankings even when the player would miss the sample cutoff', () => {
  for (const flag of ['goalsComplete', 'assistsComplete']) {
    const source = [group('Known', 20, 2, 2), group('Unknown', 1, 0, 0, { [flag]: false })];
    const result = calculatePlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance' });
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.missingMetrics, [flag.replace('Complete', '')]);
  }
});

test('a metric ranking can use its complete feed while marking unrelated unavailable data as null', () => {
  const source = [group('A', 10, 4, 0, { assistsComplete: false })];
  const result = calculatePlayerRanking(source, { metric: 'goals' });
  assert.equal(result.rows[0].goals, 4);
  assert.equal(result.rows[0].assists, null);
  assert.equal(result.rows[0].goalContributions, null);
  assert.deepEqual(calculatePlayerRanking(source, { metric: 'goals', requireBoth: true }).missingMetrics, ['assists']);
});

test('sorting uses full precision, alphabetical exact ties, and an explicit 10-row cap', () => {
  const close = calculatePlayerRanking([group('A', 31, 10, 0), group('Z', 28, 9, 0)], { metric: 'goals', basis: 'perAppearance' });
  assert.equal(close.rows[0].player, 'A');
  assert.ok(close.rows[0].perAppearance > close.rows[1].perAppearance);
  const names = Array.from({ length: 12 }, (_, i) => `Player ${String(i).padStart(2, '0')}`).reverse();
  const tied = calculatePlayerRanking(names.map(name => group(name, 10, 1, 1)), { metric: 'goalContributions' });
  assert.equal(tied.eligiblePlayers, 12);
  assert.equal(tied.rows.length, 10);
  assert.equal(tied.rows[0].player, 'Player 00');
  assert.equal(tied.rows[9].player, 'Player 09');
});

test('overlapping aggregates cannot inflate numerator or distort denominator', () => {
  assert.throws(() => calculatePlayerRanking([group('A', 10, 2, 3), group('A', 10, 2, 3)], { metric: 'goalContributions' }), /overlap/);
  assert.throws(() => calculatePlayerRanking([group('A', 10, 2, 3, { matchIds: ['one'] })], { metric: 'goalContributions' }), /inconsistent/);
});

test('zero appearances and empty eligible populations return no fabricated rate', () => {
  assert.deepEqual(calculatePlayerRanking([group('A', 0, 0, 0)], { metric: 'goalContributions', basis: 'perAppearance' }).rows, []);
  const result = executePlan({ ...combined, minimumAppearances: 1000 }, { question, context });
  assert.deepEqual(result.rows, []);
  assert.match(result.answer, /No players meet/);
});

test('club scope narrows the leaderboard and a model cannot change selected competition or season', () => {
  const club = executePlan(combined, { question, context: { ...context, team: 'Hassania Agadir' } });
  assert.ok(club.rows.length > 0);
  assert.ok(club.rows.every(row => row.club === 'Hassania Agadir'));
  for (const proposed of [{ competition: 'Championnat Féminin D1' }, { season: '2024-2025' }]) {
    const blocked = executePlan({ ...combined, ...proposed }, { question, context });
    assert.deepEqual(blocked.rows, []);
    assert.match(blocked.answer, /selected scope/);
  }
});

test('selected or named players are not silently removed to broaden a ranking', () => {
  const result = executePlan(combined, { question, context: { ...context, player: 'Omar Housni' } });
  assert.deepEqual(result.rows, []);
  assert.match(result.answer, /Clear the player selection/);
  const named = executePlan({ ...combined, player: 'Omar Housni' }, { question: 'Rank Omar Housni', context: { season: '2025-2026', competition: 'U19 Women' } });
  assert.deepEqual(named.rows, []);
});

test('ranking choices and model parameters are bounded and validated before execution', () => {
  for (const rankingBasis of ['per90', '', true, null, {}, 1]) {
    assert.throws(() => chat({ question, context, rankingBasis }), InputError);
  }
  for (const minimumAppearances of [-1, 1.2, 1001, '10', null]) {
    assert.throws(() => executePlan({ ...combined, minimumAppearances }, { question, context }), InputError);
  }
  for (const invalid of [{ basis: 'per90' }, { requireBoth: 'true' }, { metric: 'xG' }, { numerator: 'goals' }]) {
    assert.throws(() => executePlan({ ...combined, ...invalid }, { question, context }), InputError);
  }
});

const competitions = [
  { id: 'men', name: 'Senior League', category: 'MEN', ageGroup: 'SENIOR' },
  { id: 'women', name: 'Senior League 2', category: 'WOMEN', ageGroup: 'SENIOR' },
  { id: 'youth', name: 'Youth League', category: 'WOMEN', ageGroup: 'U19' },
];
const scopedGroup = (player, competitionId, appearances, goals, assists, extra = {}) => group(player, appearances, goals, assists, {
  competitionId, competition: competitions.find(item => item.id === competitionId)?.name,
  teamId: 'club', matchIds: Array.from({ length: appearances }, (_, i) => `${player}-${competitionId}-${i}`), ...extra,
});

test('category leaders reproduce event-audited totals across every competition and age group', () => {
  const result = executePlan({ ...combined, groupBy: 'category', categories: ['MEN', 'WOMEN'], limit: 1 }, { question: 'Leaders in each category', context: { season: '2025-2026', competition: 'All competitions' } });
  assert.deepEqual(result.rows.map(({ group, rank, player, appearances, goals, assists, goalContributions }) => ({ group, rank, player, appearances, goals, assists, goalContributions })), [
    { group: "Men's competitions", rank: 1, player: 'Mohamed Qadiri', appearances: 21, goals: 12, assists: 2, goalContributions: 14 },
    { group: "Women's competitions", rank: 1, player: 'Zineb Bennani', appearances: 18, goals: 7, assists: 5, goalContributions: 12 },
  ]);
  assert.deepEqual(result.evidence.ranking.groups.map(({ eligiblePlayers, sourceCount, matchCount }) => ({ eligiblePlayers, sourceCount, matchCount })), [
    { eligiblePlayers: 252, sourceCount: 916, matchCount: 387 }, { eligiblePlayers: 174, sourceCount: 633, matchCount: 273 },
  ]);
  assert.match(result.answer, /Senior and U19 competitions are included/);
});

test('a selected men-only competition keeps the explicitly requested women group empty and explained', () => {
  const result = executePlan({ ...combined, groupBy: 'category', categories: ['MEN', 'WOMEN'], limit: 1 }, { question: 'Leaders in each category', context });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].group, "Men's competitions");
  const women = result.evidence.ranking.groups.find(item => item.id === 'WOMEN');
  assert.equal(women.status, 'no_appearances');
  assert.equal(women.sourceCount, 0);
  assert.match(result.answer, /Women's competitions: No recorded appearances/);
  assert.equal(result.evidence.scope.competition, 'Botola Pro D1');
  assert.equal(result.evidence.matchCount, 240);
});

test('category filters and age filters use metadata independently of display names', () => {
  const source = [scopedGroup('Sam', 'men', 20, 10, 10), scopedGroup('Sam', 'women', 20, 2, 3), scopedGroup('Sam', 'youth', 20, 5, 5)];
  const women = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', categories: ['WOMEN'] }, competitions);
  assert.equal(women.rows[0].goalContributions, 15);
  assert.equal(women.rows[0].appearances, 40);
  assert.equal('group' in women.rows[0], false);
  const youth = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', categories: ['WOMEN'], ageGroup: 'U19' }, competitions);
  assert.equal(youth.rows[0].goalContributions, 10);
  assert.equal(youth.rows[0].appearances, 20);
  assert.deepEqual(youth.source.map(row => row.competitionId), ['youth']);
});

test('competition grouping applies the limit independently rather than selecting one global top list', () => {
  const source = [scopedGroup('A', 'men', 10, 8, 2), scopedGroup('B', 'men', 10, 5, 2), scopedGroup('C', 'women', 10, 2, 1), scopedGroup('D', 'women', 10, 1, 1)];
  const result = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', groupBy: 'competition', limit: 1 }, competitions);
  assert.deepEqual(result.rows.map(row => [row.group, row.rank, row.player]), [['Senior League', 1, 'A'], ['Senior League 2', 1, 'C']]);
  assert.deepEqual(result.groups.map(item => item.eligiblePlayers), [2, 2]);
});

test('team grouping aggregates a player across competitions before rate ranking within the club', () => {
  const source = [scopedGroup('A', 'men', 1, 2, 1), scopedGroup('A', 'women', 9, 0, 1),
    scopedGroup('B', 'men', 10, 3, 3), scopedGroup('C', 'women', 10, 1, 1, { teamId: 'other', team: 'Other Club' })];
  const result = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance', groupBy: 'team', limit: 2 }, competitions);
  assert.deepEqual(result.rows.map(row => [row.group, row.rank, row.player, row.perAppearance]), [
    ['Example Club', 1, 'B', 0.6], ['Example Club', 2, 'A', 0.4], ['Other Club', 1, 'C', 0.2],
  ]);
});

test('an incomplete group reports its missing feed without suppressing a complete peer group', () => {
  const source = [scopedGroup('A', 'men', 20, 2, 2), scopedGroup('B', 'women', 20, 1, 0, { assistsComplete: false })];
  const result = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', groupBy: 'category', categories: ['MEN', 'WOMEN'] }, competitions);
  assert.deepEqual(result.rows.map(row => row.player), ['A']);
  assert.equal(result.groups[0].status, 'available');
  assert.equal(result.groups[1].status, 'incomplete');
  assert.deepEqual(result.groups[1].missingMetrics, ['assists']);
  assert.equal(result.groups[1].eligiblePlayers, null);
});

test('minimum appearances and both-positive requirements are checked within each group', () => {
  const source = [scopedGroup('A', 'men', 5, 1, 1), scopedGroup('A', 'women', 5, 1, 1), scopedGroup('B', 'youth', 20, 0, 8)];
  const result = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', groupBy: 'category', basis: 'perAppearance', requireBoth: true }, competitions);
  assert.deepEqual(result.rows, []);
  assert.ok(result.groups.every(item => item.status === 'no_eligible_players'));
  const ungrouped = calculateGroupedPlayerRanking(source, { metric: 'goalContributions', basis: 'perAppearance', requireBoth: true }, competitions);
  assert.equal(ungrouped.rows[0].player, 'A');
  assert.equal(ungrouped.rows[0].appearances, 10);
});

test('clarification retains grouping and eligibility for the authoritative continued plan', () => {
  const plan = { ...combined, basis: 'clarify', groupBy: 'competition', limit: 2, categories: ['WOMEN'], ageGroup: 'U19', minimumAppearances: 12 };
  const body = { question: 'Rank combined output', context: { season: '2025-2026', competition: 'All competitions' } };
  const pending = executePlan(plan, body);
  assert.deepEqual(pending.evidence.ranking.categories, ['WOMEN']);
  assert.equal(pending.evidence.ranking.ageGroup, 'U19');
  assert.equal(pending.evidence.ranking.limit, 2);
  assert.equal(pending.evidence.ranking.groupBy, 'competition');
  assert.match(pending.clarification.options[1].label, /minimum 12/);
  const continued = executePlan(plan, { ...body, rankingBasis: 'perAppearance' });
  assert.equal(continued.rows.length, 2);
  assert.ok(continued.rows.every(row => row.group === 'Championnat National U19 Féminin' && row.appearances >= 12));
  assert.equal(continued.evidence.ranking.requireBoth, true);
});

test('missing category metadata cannot be replaced with an inference from competition names', () => {
  const source = [scopedGroup('A', 'women', 10, 1, 1)];
  assert.throws(() => calculateGroupedPlayerRanking(source, { metric: 'goalContributions' }, [{ id: 'women', name: 'Women League' }]), /metadata is missing/);
});

test('group dimensions and per-group limits are validated at the engine boundary', () => {
  for (const invalid of [{ groupBy: 'position' }, { limit: 0 }, { limit: 11 }, { limit: 1.5 }, { limit: '2' },
    { categories: ['SENIOR'] }, { categories: ['MEN', 'MEN'] }, { categories: 'WOMEN' }, { ageGroup: 'U23' }]) {
    assert.throws(() => executePlan({ ...combined, ...invalid }, { question, context }), InputError);
  }
});

test('pure validation returns empty evidence and calculation progress occurs only for executing plans', () => {
  const request = validateRequest({ question: 'Show top scorers', context });
  assert.equal(request.scope.competition, 'Botola Pro D1');
  assert.equal(request.evidence.matchCount, 0);
  assert.deepEqual(request.evidence.matchIds, []);
  const progress = [];
  executePlan({ ...combined, basis: 'clarify' }, { question, context }, { onProgress: stage => progress.push(stage) });
  assert.deepEqual(progress, ['checking']);
  progress.length = 0;
  executePlan({ ...combined, groupBy: 'category' }, { question, context }, { onProgress: stage => progress.push(stage) });
  assert.deepEqual(progress, ['checking', 'calculating']);
  progress.length = 0;
  executePlan({ ...combined, competition: 'Championnat Féminin D1' }, { question, context }, { onProgress: stage => progress.push(stage) });
  assert.deepEqual(progress, ['checking']);
});


test('generic category words do not silently select a single league when competition is unfiltered', () => {
  const result = executePlan({ ...combined, groupBy: 'category', categories: ['MEN', 'WOMEN'], limit: 1 }, {
    question: 'Show the best player in men and women competitions', context: { season: '2025-2026', competition: '' },
  });
  assert.equal(result.evidence.scope.competition, undefined);
  assert.deepEqual(result.rows.map(row => row.group), ["Men's competitions", "Women's competitions"]);
  const youth = executePlan({ ...combined, groupBy: 'category', categories: ['MEN', 'WOMEN'], ageGroup: 'U19', limit: 1 }, {
    question: 'Show leaders for U19 women and U19 men', context: { season: '2025-2026' },
  });
  assert.equal(youth.evidence.scope.competition, undefined);
  assert.equal(youth.rows.length, 2);
});
