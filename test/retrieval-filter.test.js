const assert = require('assert');
const test = require('node:test');
const {
  hasTopicOverlap,
  isSpecificArticleUrl,
  isStaleReportSource,
  topicTerms,
  validateRetrievedSource
} = require('../retrieval/filter');

const longText = Array(210).fill('fifa referee documentation process updated in 2026').join(' ');

test('rejects root and section URLs', () => {
  assert.equal(isSpecificArticleUrl('https://www.reuters.com'), false);
  assert.equal(isSpecificArticleUrl('https://www.bbc.com/news'), false);
  assert.equal(isSpecificArticleUrl('https://www.who.int/africa'), false);
});

test('accepts article-like URLs', () => {
  assert.equal(isSpecificArticleUrl('https://www.reuters.com/world/europe/example-story-2026-06-10/'), true);
  assert.equal(isSpecificArticleUrl('https://www.who.int/news/item/10-06-2026-example-health-update'), true);
  assert.equal(isSpecificArticleUrl('https://www.bbc.com/news/articles/cwy2ypyp4x4o'), true);
});

test('extracts useful topic terms', () => {
  assert.deepEqual(topicTerms('latest FIFA referee documentation'), ['fifa', 'referee', 'documentation']);
});

test('requires topic overlap', () => {
  assert.equal(hasTopicOverlap('FIFA referee documentation', longText), true);
  assert.equal(hasTopicOverlap('Japan inflation data', longText), false);
});

test('validates article URL, length, and topic relevance together', () => {
  assert.equal(validateRetrievedSource({
    url: 'https://www.reuters.com/world/europe/example-story-2026-06-10/',
    title: 'FIFA referee documentation',
    extracted_text: 'fifa referee documentation short trimmed paragraph',
    word_count: 250
  }, 'FIFA referee documentation').ok, true);

  assert.equal(validateRetrievedSource({
    url: 'https://www.reuters.com/world',
    title: 'FIFA referee documentation',
    extracted_text: longText
  }, 'FIFA referee documentation').reason, 'not_article_url');
});

test('does not flag normal dated news articles as stale (C1 regression)', () => {
  const article = {
    url: 'https://apnews.com/article/gaza-ceasefire-deal-abc123',
    title: 'Israel and Hamas reach ceasefire deal in June 2026',
    extracted_text: Array(60).fill('ceasefire negotiations continued through June 2026 with mediators').join(' '),
    word_count: 400
  };
  assert.equal(isStaleReportSource(article, 'gaza ceasefire negotiations'), false);
  assert.equal(validateRetrievedSource(article, 'gaza ceasefire negotiations').ok, true);
});

test('rejects hub and topic index URLs (hub filter)', () => {
  assert.equal(isSpecificArticleUrl('https://apnews.com/hub/israel-hamas-war'), false);
  assert.equal(isSpecificArticleUrl('https://www.bbc.com/news/topics/cx1m7zg0gylt'), false);
  assert.equal(isSpecificArticleUrl('https://www.aljazeera.com/tag/gaza/'), false);
});

test('rejects annual report pages for current event topics', () => {
  const source = {
    url: 'https://www.amnesty.org/en/location/middle-east-and-north-africa/middle-east/iran/report-iran/',
    title: 'Iran 2025',
    extracted_text: 'Iran 2025 On 13 June, Israel launched air strikes on Iranian territory.',
    word_count: 500
  };

  assert.equal(isStaleReportSource(source, 'Israel Iran conflict'), true);
  assert.equal(validateRetrievedSource(source, 'Israel Iran conflict').reason, 'stale_report_source');
  assert.equal(validateRetrievedSource(source, 'Iran human rights report 2025').ok, true);
});

test('title-anchored gate rejects tangential mentions (Lebanon-statement case)', () => {
  const { topicRelevance } = require('../retrieval/filter');
  const lebanonStatement = {
    url: 'https://www.state.gov/releases/2026/06/joint-statement-trilateral-meeting',
    title: 'Joint Statement of the United States, Republic of Lebanon, and State of Israel on the Latest High-Level Trilateral Meeting',
    extracted_text: Array(60).fill('Israel and Lebanon agreed to the implementation of a ceasefire after negotiations.').join(' '),
    word_count: 600
  };
  assert.equal(validateRetrievedSource(lebanonStatement, 'Gaza ceasefire negotiations').reason, 'topic_mismatch');

  const gazaArticle = {
    ...lebanonStatement,
    url: 'https://www.aljazeera.com/news/2026/6/7/gaza-ceasefire-talks-cairo',
    title: 'Egypt hosts renewed Gaza ceasefire talks in Cairo'
  };
  assert.equal(validateRetrievedSource(gazaArticle, 'Gaza ceasefire negotiations').ok, true);

  // Title hits weigh double in the relevance score.
  const titled = topicRelevance('Gaza ceasefire talks', 'Gaza ceasefire talks stall', 'no terms here');
  const buried = topicRelevance('Gaza ceasefire talks', 'Unrelated headline', 'gaza ceasefire talks mentioned in body');
  assert.ok(titled.score > buried.score);
});
