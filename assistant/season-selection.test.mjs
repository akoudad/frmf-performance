import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSeasonSelection, toggleSeason, seasonSelectionSummary, seasonCatalogParams } from './public/season-selection.mjs';

const seasons = ['2023-2024', '2024-2025', '2025-2026'];

test('season selection keeps catalog order, removes duplicates and unavailable values', () => {
  assert.deepEqual(normalizeSeasonSelection(seasons, ['2025-2026', '2023-2024', '2023-2024', '2030-2031']), ['2023-2024', '2025-2026']);
  assert.deepEqual(normalizeSeasonSelection(seasons, []), ['2025-2026']);
  assert.deepEqual(normalizeSeasonSelection(['2021-2022'], []), ['2021-2022']);
  assert.deepEqual(normalizeSeasonSelection([], []), []);
});

test('a user can select one, several or all seasons but cannot remove the last one', () => {
  let chosen = ['2025-2026'];
  assert.deepEqual(toggleSeason(seasons, chosen, '2025-2026', false), chosen);
  chosen = toggleSeason(seasons, chosen, '2023-2024', true);
  assert.deepEqual(chosen, ['2023-2024', '2025-2026']);
  chosen = toggleSeason(seasons, chosen, '2024-2025', true);
  assert.deepEqual(chosen, seasons);
  assert.deepEqual(toggleSeason(seasons, chosen, '2024-2025', false), ['2023-2024', '2025-2026']);
  assert.deepEqual(toggleSeason(seasons, chosen, 'not-a-season', true), chosen);
});

test('catalog requests preserve every selected season without comma-joining or a legacy season', () => {
  const params = seasonCatalogParams({ seasons, competition: 'Championnat Féminin D1', team: 'All' });
  assert.deepEqual(params.getAll('seasons'), seasons);
  assert.equal(params.has('season'), false);
  assert.equal(params.get('competition'), 'Championnat Féminin D1');
  assert.equal(new URLSearchParams(params.toString()).get('competition'), 'Championnat Féminin D1');
  assert.equal(seasonSelectionSummary(seasons, ['2025-2026']), '2025–2026');
  assert.equal(seasonSelectionSummary(seasons, seasons), 'All 3 seasons');
  assert.equal(seasonSelectionSummary(seasons, seasons.slice(0, 2)), '2 seasons');
});
