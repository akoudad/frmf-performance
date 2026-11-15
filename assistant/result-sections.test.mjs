import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResultSections, renderResultSections, queryEvidenceAnchor } from './public/result-sections.mjs';

// Minimal DOM surface keeps the presentation checks independent of a browser.
function fixture() {
  const document = { createElement: tagName => ({
    tagName, ownerDocument: document, children: [], attributes: {}, listeners: {}, textContent: '',
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, handler) { this.listeners[event] = handler; },
  }) };
  const container = document.createElement('div'), tables = [], opened = [];
  return {
    container, tables, opened,
    render: response => renderResultSections(container, response, {
      appendTable(wrap, rows, columns) {
        tables.push({ rows, columns });
        const table = document.createElement('table');
        for (const row of rows) {
          const tr = document.createElement('tr');
          for (const key of columns) { const td = document.createElement('td'); td.textContent = String(row[key]); tr.append(td); }
          table.append(tr);
        }
        wrap.append(table);
      },
      openEvidence: anchor => opened.push(anchor),
    }),
  };
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const visibleText = element => descendants(element).map(child => child.textContent).filter(Boolean).join(' ');
const tagged = (element, tag) => descendants(element).filter(child => child.tagName === tag);

test('renders both requested leaders in separate titled blocks with matching query evidence', () => {
  const view = fixture();
  view.render({
    sections: [
      { id: 'S1', title: "Men’s leader", status: 'answered', taskIds: ['T1'], queryId: 'Q2', columns: ['player', 'goals'], rows: [{ player: 'Omar Housni', goals: 18 }] },
      { id: 'S2', title: "Women’s leader", status: 'answered', taskIds: ['T2'], queryId: 'Q1', columns: ['player', 'goals'], rows: [{ player: 'Zineb Bennani', goals: 22 }] },
    ],
    // The old single-result payload must not replace or duplicate the sections.
    rows: [{ player: 'Legacy result' }],
    evidence: { queries: [{ id: 'Q1' }, { id: 'Q2' }] },
  });
  assert.equal(view.container.children.length, 2);
  assert.deepEqual(tagged(view.container, 'h3').map(title => title.textContent), ["Men’s leader", "Women’s leader"]);
  assert.deepEqual(tagged(view.container, 'table').map(visibleText), ['Omar Housni 18', 'Zineb Bennani 22']);
  const links = tagged(view.container, 'a');
  assert.deepEqual(links.map(link => link.href), ['#evidence-query-2', '#evidence-query-1']);
  let prevented = false;
  links[0].listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(view.opened, [queryEvidenceAnchor(1)]);
  assert.doesNotMatch(visibleText(view.container), /S1|T1|Q2|Legacy result/);
});

test('legacy rows remain renderable when structured sections are absent or empty', () => {
  for (const sections of [undefined, []]) {
    const view = fixture();
    view.render({ sections, rows: [{ player: 'Omar Housni', goalContributions: 31 }] });
    assert.deepEqual(view.tables, [{ rows: [{ player: 'Omar Housni', goalContributions: 31 }], columns: ['player', 'goalContributions'] }]);
    assert.match(visibleText(view.container), /Results Omar Housni 31/);
  }
  const view = fixture();
  view.render({ status: 'clarification', rows: [], clarification: { question: 'Which season?' } });
  assert.equal(view.container.children.length, 0);
});

test('technical columns stay out of display records without changing names or raw evidence', () => {
  const row = Object.freeze({ player_id: 123, player: 'Omar Housni', team_id: 41, team: 'Hassania Agadir', competition_id: 2, edition_id: 19, goals: 18, goals_complete: true, assists_complete: false });
  const response = { sections: [{ title: 'Leading scorer', columns: Object.keys(row).map(name => ({ name })), rows: [row] }], evidence: { queries: [{ id: 'Q1', rows: [row] }] } };
  const [section] = normalizeResultSections(response);
  assert.deepEqual(section.columns, ['player', 'team', 'goals']);
  assert.deepEqual(section.rows, [{ player: 'Omar Housni', team: 'Hassania Agadir', goals: 18 }]);
  assert.equal(response.evidence.queries[0].rows[0], row);
  assert.equal(row.player_id, 123);
  assert.equal(row.assists_complete, false);
  const view = fixture(); view.render(response);
  assert.match(visibleText(view.container), /Omar Housni Hassania Agadir 18/);
  assert.doesNotMatch(visibleText(view.container), /123|41|true|false/);
});

test('filtering array-backed legacy rows preserves each value under its original column', () => {
  const [section] = normalizeResultSections({ columns: ['player_id', 'player', 'goals_complete', 'goals'], rows: [[9, 'Zineb Bennani', true, 22]] });
  assert.deepEqual(section.columns, ['player', 'goals']);
  assert.deepEqual(section.rows, [{ player: 'Zineb Bennani', goals: 22 }]);
});

test('empty and unavailable tasks remain visible with explicit notes and no fabricated table', () => {
  const view = fixture();
  view.render({ sections: [
    { title: 'Top scorers', status: 'empty', rows: [], note: 'No players matched the selected club.' },
    { title: 'Expected goals', status: 'unavailable', rows: [], queryId: null, note: 'Expected goals are not recorded in this source.' },
  ] });
  assert.equal(view.container.children.length, 2);
  assert.equal(view.tables.length, 0);
  assert.match(visibleText(view.container.children[0]), /No matching records\. No players matched the selected club\./);
  assert.match(visibleText(view.container.children[1]), /This result is unavailable\. Expected goals are not recorded in this source\./);
  assert.equal(tagged(view.container, 'a').length, 0);
});

test('partial results keep valid records and useful coverage warnings visible', () => {
  const view = fixture();
  view.render({ sections: [{ title: 'Assists', status: 'incomplete', rows: [{ player: 'Zineb Bennani', assists: 9 }],
    note: 'Some matches are missing.', warnings: ['Only 12 of 18 matches have assist data.', 'Only 12 of 18 matches have assist data.'], queryId: 'missing' }] });
  assert.match(visibleText(view.container), /Partial result\. Some matches are missing\./);
  assert.match(visibleText(view.container), /Zineb Bennani 9/);
  assert.deepEqual(tagged(view.container, 'li').map(item => item.textContent), ['Only 12 of 18 matches have assist data.']);
  assert.equal(tagged(view.container, 'a').length, 0);
});

test('renders untrusted titles and notices as literal text and replaces previous results', () => {
  const view = fixture();
  view.render({ rows: [{ player: 'Previous result' }] });
  view.render({ tasks: [{ id: 'T1', label: '<img src=x onerror=alert(1)>' }], sections: [{ taskIds: ['T1'], status: 'answered', rows: [], note: '<script>alert(1)</script>' }] });
  assert.equal(view.container.children.length, 1);
  assert.equal(tagged(view.container, 'h3')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(tagged(view.container, 'img').length, 0);
  assert.equal(tagged(view.container, 'script').length, 0);
  assert.match(visibleText(view.container), /No matching records\./);
  assert.doesNotMatch(visibleText(view.container), /Previous result/);
});
