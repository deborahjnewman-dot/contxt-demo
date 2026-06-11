const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { selectSearches } = require('../retrieval/targeted');

const searches = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'retrieval', 'sources.json'), 'utf8')
).searches;

test('pulls country-relevant outlets into the selection for a named-country topic (H6)', () => {
  const labels = selectSearches(searches, 'Russia Ukraine war frontline').map((s) => s.label);
  assert.ok(labels.includes('Russia Official (State Media)'), 'expected Russia outlet in selection');
  assert.ok(labels.includes('Ukraine Official'), 'expected Ukraine outlet in selection');
  // High-priority wires are still present.
  assert.ok(labels.includes('Reuters'));
  assert.ok(labels.includes('AP'));
});

test('without a country match, Russia/Ukraine outlets fall outside the default cut', () => {
  const labels = selectSearches(searches, 'general technology policy update').map((s) => s.label);
  assert.equal(labels.includes('Russia Official (State Media)'), false);
});

test('selection never exceeds the configured cap', () => {
  assert.ok(selectSearches(searches, 'Russia Ukraine China Iran United States').length <= 14);
});

test('topic signals pull specialized searches into the selection', () => {
  // topic_signals is an optional per-search key the client can add to
  // sources.json; verify the selection lift with an inline config.
  const configured = [
    ...Array.from({ length: 14 }, (_, i) => ({ label: `Search ${i}`, query: `site:example${i}.com`, priority: 'medium', source_type: 'news' })),
    { label: 'Health Organizations', query: 'site:msf.org', priority: 'low', source_type: 'civil_society', topic_signals: ['outbreak', 'epidemic', 'cholera'] }
  ];

  const withSignal = selectSearches(configured, 'cholera outbreak in Sudan refugee camps').map((s) => s.label);
  assert.ok(withSignal.includes('Health Organizations'), 'expected the signal match to beat higher-priority generic searches');

  const withoutSignal = selectSearches(configured, 'general technology policy update').map((s) => s.label);
  assert.equal(withoutSignal.includes('Health Organizations'), false);
});
