/** Keep selections in catalog order and retain at least one available season. */
export function normalizeSeasonSelection(available, selected, preferred = '2025-2026') {
  const seasons = [...new Set(available.filter(value => typeof value === 'string' && value))];
  const chosen = new Set(Array.isArray(selected) ? selected : []);
  const result = seasons.filter(season => chosen.has(season));
  return result.length ? result : seasons.includes(preferred) ? [preferred] : seasons.length ? [seasons.at(-1)] : [];
}

export function toggleSeason(available, selected, season, checked) {
  const current = normalizeSeasonSelection(available, selected);
  if (!available.includes(season)) return current;
  const next = checked ? [...current, season] : current.filter(value => value !== season);
  return next.length ? normalizeSeasonSelection(available, next) : current;
}

export function seasonSelectionSummary(available, selected) {
  if (!selected.length) return 'Loading seasons…';
  if (selected.length === 1) return selected[0].replace('-', '–');
  return selected.length === available.length ? `All ${selected.length} seasons` : `${selected.length} seasons`;
}

/** Repeated parameters preserve the union of selected seasons for the catalog. */
export function seasonCatalogParams(context) {
  const params = new URLSearchParams();
  for (const season of context.seasons) params.append('seasons', season);
  params.set('competition', context.competition || 'All');
  return params;
}
