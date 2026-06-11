const { contentSize, MIN_EXTRACTED_WORDS } = require('./extract');
const STOPWORDS = new Set([
  'about', 'after', 'against', 'also', 'amid', 'and', 'are', 'around', 'before',
  'between', 'but', 'from', 'has', 'have', 'how', 'into', 'its', 'latest',
  'new', 'news', 'not', 'over', 'said', 'says', 'that', 'the', 'their', 'this',
  'through', 'with', 'what', 'when', 'where', 'while', 'why'
]);
const SECTION_SEGMENTS = new Set([
  'africa', 'americas', 'asia', 'business', 'culture', 'economy', 'emergencies',
  'europe', 'health', 'home', 'international', 'latest', 'middle-east', 'news',
  'opinion', 'politics', 'science', 'sport', 'sports', 'technology', 'uk',
  'us', 'world'
]);
// Index/aggregation path segments. A URL whose path routes through one of these
// is a hub or topic index, never a single article.
const INDEX_PATH_SEGMENTS = new Set([
  'hub', 'hubs', 'tag', 'tags', 'topic', 'topics', 'category', 'categories',
  'live', 'author', 'authors', 'search', 'section'
]);

function validateRetrievedSource(source, topic) {
  if (!isSpecificArticleUrl(source.url)) {
    return { ok: false, reason: 'not_article_url' };
  }

  if (isStaleReportSource(source, topic)) {
    return { ok: false, reason: 'stale_report_source' };
  }

  const extractedText = String(source.extracted_text || '');
  const sourceWordCount = Number(source.word_count) || contentSize(extractedText);
  if (sourceWordCount < MIN_EXTRACTED_WORDS) {
    return { ok: false, reason: 'insufficient_extracted_text' };
  }

  const relevance = topicRelevance(topic, source.title, extractedText);
  // Title-anchored gate: an article about the topic names it in the headline.
  // Passing mentions buried in the body (e.g. a Lebanon-ceasefire statement
  // that says "ceasefire" and "negotiations") are not topical coverage.
  if (relevance.titleHits === 0 && relevance.textHits < Math.min(3, relevance.termCount)) {
    return { ok: false, reason: 'topic_mismatch' };
  }

  return { ok: true, relevance: relevance.score };
}

// Relevance in [0, 1]; title hits weigh double because headlines state what an
// article is actually about.
function topicRelevance(topic, title, text) {
  const terms = topicTerms(topic);
  if (terms.length === 0) return { titleHits: 0, textHits: 0, termCount: 0, score: 1 };

  const titleHay = String(title || '').toLowerCase();
  const textHay = String(text || '').toLowerCase();
  const titleHits = terms.filter((term) => titleHay.includes(term)).length;
  const textHits = terms.filter((term) => textHay.includes(term)).length;

  return {
    titleHits,
    textHits,
    termCount: terms.length,
    score: (2 * titleHits + textHits) / (3 * terms.length)
  };
}

function isStaleReportSource(source, topic) {
  const topicText = String(topic || '').toLowerCase();
  if (/\b(report|annual|human rights|amnesty)\b/.test(topicText)) return false;

  let pathname = '';
  try {
    pathname = new URL(source.url).pathname.toLowerCase();
  } catch (error) {
    pathname = '';
  }

  // Only the structural "annual report" index URL is treated as stale. The
  // previous title/text year heuristic flagged almost every dated news article
  // (e.g. "ceasefire deal in June 2026") as a stale report, starving retrieval.
  return /\/(location|report|reports|annual-report)\/.*report[^/]*\/?$/.test(pathname);
}

function isSpecificArticleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }

  const segments = url.pathname
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  if (segments.length < 2) return false;

  // Hub/topic index pages (apnews.com/hub/..., site/tag/..., /topics/...) are
  // aggregations, not articles, even when the trailing slug looks article-like.
  if (segments.some((segment) => INDEX_PATH_SEGMENTS.has(segment))) return false;

  const last = segments[segments.length - 1].replace(/\.(html?|php|aspx?)$/i, '');
  if (!last || SECTION_SEGMENTS.has(last)) return false;

  return (
    /\/articles\/[a-z0-9]+/i.test(url.pathname) ||
    /\d{4}/.test(url.pathname) ||
    /\d{6,}/.test(url.pathname) ||
    /[a-z]+-[a-z]+/.test(last) ||
    last.length >= 18
  );
}

function hasTopicOverlap(topic, text) {
  const terms = topicTerms(topic);
  if (terms.length === 0) return true;

  const haystack = String(text || '').toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term));
  const requiredHits = terms.length >= 4 ? 2 : 1;
  return hits.length >= requiredHits;
}

function topicTerms(topic) {
  return [...new Set(String(topic || '')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) || [])]
    .filter((term) => !STOPWORDS.has(term));
}

module.exports = {
  hasTopicOverlap,
  isSpecificArticleUrl,
  isStaleReportSource,
  topicRelevance,
  topicTerms,
  validateRetrievedSource
};
