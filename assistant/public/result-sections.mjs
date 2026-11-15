const statuses = new Set(['answered', 'empty', 'unavailable', 'incomplete']);
const hiddenColumn = key => /^(player|team|competition|edition)_id$/i.test(key) || /_complete$/i.test(key);
const nonemptyText = value => typeof value === 'string' && value.trim() ? value : '';

export const queryEvidenceAnchor = index => `evidence-query-${index + 1}`;

// Project display records without changing the full records retained in evidence.
export function normalizeResultSections(response = {}) {
  const explicit = Array.isArray(response.sections) && response.sections.length > 0;
  const source = explicit ? response.sections : Array.isArray(response.rows) && response.rows.length
    ? [{ title: 'Results', status: response.status === 'incomplete' ? 'incomplete' : 'answered', rows: response.rows, columns: response.columns }]
    : [];
  const queries = Array.isArray(response.evidence?.queries) ? response.evidence.queries : [];
  const tasks = Array.isArray(response.tasks) ? response.tasks : [];
  return source.filter(section => section && typeof section === 'object' && !Array.isArray(section)).map((section, index) => {
    const sourceRows = Array.isArray(section.rows) ? section.rows.filter(row => row && typeof row === 'object') : [];
    const sourceColumns = Array.isArray(section.columns) && section.columns.length
      ? section.columns.map(column => typeof column === 'string' ? column : column?.name)
      : [...new Set(sourceRows.flatMap(row => Object.keys(row)))];
    const columns = [...new Set(sourceColumns.filter(key => typeof key === 'string' && key && !hiddenColumn(key)))];
    const rows = sourceRows.map(row => Object.fromEntries(columns.map(key => [key, Array.isArray(row) ? row[sourceColumns.indexOf(key)] : row[key]])));
    const taskLabels = Array.isArray(section.taskIds) ? section.taskIds.map(id => nonemptyText(tasks.find(task => task?.id === id)?.label)).filter(Boolean) : [];
    const status = statuses.has(section.status) ? section.status : rows.length ? 'answered' : 'empty';
    const queryIndex = typeof section.queryId === 'string' ? queries.findIndex(query => query?.id === section.queryId) : -1;
    return {
      title: nonemptyText(section.title) || taskLabels.join(' / ') || `Result ${index + 1}`,
      status: status === 'answered' && !rows.length ? 'empty' : status,
      columns,
      rows,
      note: nonemptyText(section.note),
      warnings: Array.isArray(section.warnings) ? [...new Set(section.warnings.map(nonemptyText).filter(Boolean))] : [],
      evidenceAnchor: queryIndex < 0 ? null : queryEvidenceAnchor(queryIndex),
    };
  });
}

export function renderResultSections(container, response, { appendTable, openEvidence }) {
  const document = container.ownerDocument;
  const sections = normalizeResultSections(response);
  container.replaceChildren();
  for (const section of sections) {
    const block = document.createElement('section'); block.className = 'result-section';
    const heading = document.createElement('div'); heading.className = 'result-heading';
    const title = document.createElement('h3'); title.textContent = section.title; heading.append(title);
    if (section.evidenceAnchor) {
      const link = document.createElement('a'); link.className = 'result-evidence';
      link.href = `#${section.evidenceAnchor}`; link.textContent = 'View query evidence';
      link.setAttribute('aria-label', `View query evidence for ${section.title}`);
      link.addEventListener('click', event => { event.preventDefault(); openEvidence(section.evidenceAnchor); });
      heading.append(link);
    }
    block.append(heading);
    const statusText = { empty: 'No matching records.', unavailable: 'This result is unavailable.', incomplete: 'Partial result.' }[section.status];
    if (statusText || section.note) {
      const note = document.createElement('p'); note.className = section.status === 'answered' ? 'muted result-note' : 'notice result-note';
      note.textContent = [statusText, section.note].filter(Boolean).join(' '); block.append(note);
    }
    if (section.rows.length && section.columns.length) {
      const wrap = document.createElement('div'); wrap.className = 'table-wrap';
      appendTable(wrap, section.rows, section.columns); block.append(wrap);
    }
    if (section.warnings.length) {
      const warnings = document.createElement('ul'); warnings.className = 'notice result-warnings';
      for (const warning of section.warnings) {
        const item = document.createElement('li'); item.textContent = warning; warnings.append(item);
      }
      block.append(warnings);
    }
    container.append(block);
  }
  return sections;
}
