const assert = require('assert');
const test = require('node:test');
const {
  analyzeGeographicCoverage,
  countriesInSources,
  countriesInTopic,
  formatForModel,
  sourceClass
} = require('../retrieval/format');

function source(overrides) {
  return {
    source_name: 'Example',
    source_type: 'news',
    url: 'https://example.com/story-2026-06-10',
    published_at: '2026-06-10T00:00:00.000Z',
    title: 'Example',
    extracted_text: 'Example text',
    quotes: [],
    language: 'en',
    relevance_score: 0.5,
    priority: 'medium',
    ...overrides
  };
}

test('classifies source hierarchy', () => {
  assert.equal(sourceClass(source({ source_type: 'government', url: 'https://state.gov/briefing' })), 'primary');
  assert.equal(sourceClass(source({ source_name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' })), 'wire');
  assert.equal(sourceClass(source({ url: 'https://example.com/story-2026-06-10/' })), 'independent');
});

test('classifies state media as its own lowest tier (H2)', () => {
  assert.equal(sourceClass(source({ source_type: 'government', state_media: true, url: 'https://kremlin.ru/x' })), 'state_media');
  // State media never outranks AP/Reuters wire sources.
  const result = formatForModel('russia ukraine war', [[
    source({ source_name: 'Russia Official', source_type: 'government', state_media: true, url: 'https://kremlin.ru/news-item-2026', relevance_score: 0.99 }),
    source({ source_name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/', relevance_score: 0.1 })
  ]]);
  assert.equal(result.value.sources[0].source_name, 'Reuters');
});

test('country term matching is word-bounded (H5)', () => {
  // "us" must not match inside "virus".
  assert.deepEqual(countriesInTopic('virus outbreak in china'), ['China']);
  assert.deepEqual(countriesInTopic('US military drug boat strikes'), ['United States']);
});

test('ranks primary sources before wire and independent news', () => {
  const result = formatForModel('test topic', [[
    source({ source_name: 'Independent', url: 'https://example.com/story-2026-06-10/', relevance_score: 0.99 }),
    source({ source_name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/', relevance_score: 0.5 }),
    source({ source_name: 'US Government', source_type: 'government', url: 'https://state.gov/briefing-2026-06-10', relevance_score: 0.1 })
  ]]);

  assert.equal(result.value.sources[0].source_name, 'US Government');
  assert.equal(result.value.sources[1].source_name, 'Reuters');
});

test('detects geographic coverage gaps', () => {
  assert.deepEqual(countriesInTopic('Iran and United States economy talks'), ['United States', 'Iran']);
  assert.deepEqual(countriesInSources([
    source({ source_name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' }),
    source({ source_name: 'US Government', url: 'https://state.gov/briefing-2026-06-10' })
  ]), ['United States']);

  const coverage = analyzeGeographicCoverage('Iran and United States economy talks', [
    source({ source_name: 'US Government', url: 'https://state.gov/briefing-2026-06-10' })
  ]);
  assert.equal(coverage.sufficient, false);
  assert.deepEqual(coverage.missingCountries, ['Iran']);
});

test('maps domains to reader-facing outlet names in the model package', () => {
  const { displaySourceName } = require('../retrieval/format');
  assert.equal(displaySourceName({ source_name: 'US Government', url: 'https://www.state.gov/releases/2026/06/statement' }), 'U.S. State Department');
  assert.equal(displaySourceName({ source_name: 'UN and International Bodies', url: 'https://press.un.org/en/2026/sc15700.doc.htm' }), 'United Nations');
  assert.equal(displaySourceName({ source_name: 'AP', url: 'https://apnews.com/article/x-y' }), 'AP');

  const result = formatForModel('test topic', [[source({ source_name: 'US Government', source_type: 'government', url: 'https://state.gov/briefing-2026-06-10' })]]);
  assert.match(result.value.packageText, /Name: U\.S\. State Department/);
});
