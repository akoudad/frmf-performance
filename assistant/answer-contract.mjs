// A reusable presentation contract. The model chooses the investigation; only
// executed query cells can supply tables. Raw evidence is kept separately.
export const taskSchema = {
  type: 'array', maxItems: 8, items: {
    type: 'object', additionalProperties: false,
    properties: { id: { type: 'string', pattern: '^T[1-8]$' }, label: { type: 'string', minLength: 1, maxLength: 240 } },
    required: ['id', 'label'],
  },
};

export const sectionSchema = {
  type: 'array', maxItems: 8, items: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      task_ids: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^T[1-8]$' } },
      query_id: { type: 'string', pattern: '^(Q[1-8])?$' },
      columns: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 } },
      row_indices: { type: 'array', maxItems: 60, items: { type: 'integer', minimum: 0, maximum: 199 } },
      status: { type: 'string', enum: ['answered', 'unavailable'] },
      note: { type: 'string', maxLength: 1600 },
    },
    required: ['title', 'task_ids', 'query_id', 'columns', 'row_indices', 'status', 'note'],
  },
};

const ordinaryText = (value, maximum) => typeof value === 'string' && value.trim() && value.length <= maximum
  && !/[\u0000-\u001f]/.test(value);
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');

export function validateTasks(tasks, previous = []) {
  if (!Array.isArray(tasks) || tasks.length > 8 || tasks.some(task =>
    !exactKeys(task, ['id', 'label']) || !/^T[1-8]$/.test(task.id) || !ordinaryText(task.label, 240))
    || new Set(tasks.map(task => task.id)).size !== tasks.length) {
    throw new Error('Supply distinct tasks with id T1 through T8 and concise labels preserving the requested analyses.');
  }
  if (previous.length && tasks.length && (tasks.length !== previous.length
    || tasks.some(task => !previous.some(recorded => recorded.id === task.id)))) {
    throw new Error('The request checklist is already recorded. Keep it unchanged, or send tasks: []. Resolve every recorded task in the final sections.');
  }
  return structuredClone(previous.length ? previous : tasks);
}

const internalColumn = name => /^(player|team|competition|edition)_id$/i.test(name) || /_complete$/i.test(name);
export const visibleColumns = query => query.columns.filter(name => !internalColumn(name));
export const duplicateRowCount = query => query.rows.length - new Set(query.rows.map(row => JSON.stringify(query.columns.map(column => row[column])))).size;
export function boundedResultRows(query) {
  const rows = []; let bytes = 0;
  for (const row of query.rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (rows.length >= 60 || bytes + size > 8000) break;
    rows.push(row); bytes += size;
  }
  return rows;
}

function warningsFor(query, columns) {
  const warnings = [];
  for (const column of query.columns.filter(name => /_complete$/i.test(name))) {
    if (query.rows.some(row => row[column] === 0 || row[column] === null)) {
      const metric = column.replace(/_complete$/i, '').replaceAll('_', ' ');
      warnings.push(`Some ${metric} records are missing. Displayed values may be partial; a complete total or ranking is not established.`);
    }
  }
  if (query.rows.some(row => columns.some(column => row[column] === null))) {
    warnings.push('Some requested values are unavailable. Missing data is not zero.');
  }
  if (query.truncated) warnings.push('This query was limited; these rows do not establish a complete ranking.');
  return warnings;
}

export function querySection(query, { title, taskIds = [], columns = visibleColumns(query), note = '', status } = {}) {
  const warnings = warningsFor(query, columns);
  return { title, taskIds, queryId: query.id, columns,
    rows: query.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))),
    note: note || (!query.rows.length ? 'No matching records in the selected scope. This does not mean zero performance.' : ''),
    warnings, status: status || (warnings.length ? 'incomplete'
      : query.rows.length ? 'answered' : 'empty') };
}

export function assembleSections(descriptors, tasks, cited, renderMessage) {
  if (!tasks.length) throw new Error('Record the requested analyses in tasks before answering.');
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 8) {
    throw new Error('Provide a titled section for each requested analysis.');
  }
  const covered = new Set(), shown = new Set(), projections = new Set();
  const sections = descriptors.map((section, index) => {
    if (!exactKeys(section, ['title', 'task_ids', 'query_id', 'columns', 'row_indices', 'status', 'note'])
      || !ordinaryText(section.title, 120) || !Array.isArray(section.task_ids) || !section.task_ids.length || section.task_ids.length > 8
      || new Set(section.task_ids).size !== section.task_ids.length
      || section.task_ids.some(id => !tasks.some(task => task.id === id))
      || !Array.isArray(section.columns) || section.columns.length > 20
      || section.columns.some(column => !ordinaryText(column, 120)) || new Set(section.columns).size !== section.columns.length
      || !Array.isArray(section.row_indices) || section.row_indices.length > 60
      || section.row_indices.some(index => !Number.isInteger(index) || index < 0 || index > 199)
      || new Set(section.row_indices).size !== section.row_indices.length
      || !['answered', 'unavailable'].includes(section.status) || typeof section.note !== 'string' || section.note.length > 1600
      || typeof section.query_id !== 'string' || !/^(Q[1-8])?$/.test(section.query_id)) {
      throw new Error('A section has invalid fields, unknown task IDs or repeated columns. Follow the section schema.');
    }
    section.task_ids.forEach(id => covered.add(id));
    const note = renderMessage(section.note, `sections[${index}].note`);
    if (section.status === 'unavailable') {
      if (section.query_id || section.columns.length || section.row_indices.length || !note.trim()) {
        throw new Error('An unavailable section needs a specific missing-data or unresolved-analysis explanation, empty query_id, columns and row_indices.');
      }
      return { id: `S${index + 1}`, title: section.title, taskIds: section.task_ids, queryId: null,
        status: 'unavailable', columns: [], rows: [], note, warnings: [] };
    }
    const query = cited.find(query => query.id === section.query_id);
    if (!query) throw new Error('Each answered section must reference a successful cited query.');
    if (section.columns.some(column => !query.columns.includes(column))) throw new Error('Section columns must be exact aliases returned by its query.');
    if (section.row_indices.some(index => index >= query.rows.length)) throw new Error('Section row_indices must be zero-based indices of actual rows in its cited query.');
    const columns = (section.columns.length ? section.columns : query.columns).filter(column => !internalColumn(column));
    if (!columns.length) throw new Error('A result section needs readable result columns, not just internal identifiers or coverage flags.');
    const indices = section.row_indices.length ? section.row_indices : query.rows.map((_row, index) => index);
    const projection = JSON.stringify([query.id, [...indices].sort((a, b) => a - b), [...columns].sort()]);
    if (projections.has(projection)) throw new Error('Two sections repeat the same query rows and columns under different headings. Use a single combined section, or select the actual relevant row_indices for each separate analysis, including every qualifying tie.');
    projections.add(projection);
    shown.add(query.id);
    return { id: `S${index + 1}`, rowIndices: indices, ...querySection({ ...query, rows: indices.map(index => query.rows[index]) },
      { title: section.title, taskIds: section.task_ids, columns, note }) };
  });
  const missing = tasks.filter(task => !covered.has(task.id));
  if (missing.length) throw new Error(`The answer omits requested analyses: ${missing.map(task => `${task.id}: ${task.label}`).join('; ')}. Add their result sections or explain specifically what remains unavailable.`);
  if (cited.some(query => !shown.has(query.id))) throw new Error('Every cited result needs a visible section. Supporting or exploratory queries can remain uncited in evidence. Do not discard an earlier requested result.');
  return sections;
}

export function incompleteSections(queries, tasks) {
  return [
    ...queries.map(query => {
      const rows = boundedResultRows(query);
      return querySection({ ...query, rows }, { title: `Calculated result ${query.id}`, status: 'incomplete',
        note: 'The calculation completed, but its interpretation and coverage of your question have not been confirmed.'
          + (rows.length < query.rows.length ? ' This is a display preview; additional calculated rows remain in query evidence.' : '') });
    }),
    ...tasks.map(task => ({ title: task.label, taskIds: [task.id], queryId: null, status: 'incomplete', columns: [], rows: [], warnings: [],
      note: 'This requested analysis was not confirmed before the investigation stopped.' })),
  ].map((section, index) => ({ id: `S${index + 1}`, ...section }));
}
