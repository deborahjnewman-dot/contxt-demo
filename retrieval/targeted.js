const fs = require('fs');
const path = require('path');
const { requestJson, requestText } = require('./http');
const { extractArticle } = require('./extract');
const { validateRetrievedSource, isSpecificArticleUrl } = require('./filter');
const { COUNTRY_SIGNALS, countriesInTopic } = require('./format');
const { ok } = require('./result');

const SOURCES_PATH = path.join(__dirname, 'sources.json');
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_TARGETED_SEARCHES = Number(process.env.MAX_TARGETED_SEARCHES) || 14;
const BRAVE_RESULT_COUNT = Number(process.env.BRAVE_RESULT_COUNT) || 4;
const MAX_ARTICLES_PER_SEARCH = Number(process.env.MAX_ARTICLES_PER_SEARCH) || 3;
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

function readSourceConfig(logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
    return Array.isArray(parsed.searches) ? parsed.searches : [];
  } catch (error) {
    logger.warn({ error: error.message }, 'retrieval: sources.json could not be read — using no searches');
    return [];
  }
}

async function fetchTargetedSources(topic, logger, freshness) {
  const searches = selectSearches(readSourceConfig(logger), topic);
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    logger.warn({ searches: searches.length }, 'retrieval: BRAVE_SEARCH_API_KEY not set — cannot search, no sources will be found');
    return ok([]);
  }

  const perSearch = await Promise.all(searches.map(async (search) => {
    const result = await queryBraveSearch(`${topic} ${search.query}`, logger.child({ search: search.label }), freshness);
    if (!result.ok) return [];
    return result.value
      .slice(0, MAX_ARTICLES_PER_SEARCH)
      .map((article) => ({ article, search }));
  }));

  const allCandidates = perSearch.flat();
  // Filter and dedupe by URL before fetching: the same article often surfaces
  // in several searches, and hub/index URLs are never worth a fetch.
  const candidates = dedupeFetchableCandidates(allCandidates, logger);
  const sources = (await Promise.all(candidates.map(({ article, search }) => {
    return articleToSource(topic, article, search, logger.child({ search: search.label }));
  }))).filter(Boolean);

  logger.info({ searches: searches.length, freshness, candidates: allCandidates.length, fetched: candidates.length, kept: sources.length }, 'retrieval: targeted search finished');
  return ok(sources);
}

function dedupeFetchableCandidates(candidates, logger) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const url = candidate.article.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (!isSpecificArticleUrl(url)) {
      logger.debug({ label: candidate.search.label, url, reason: 'not_article_url' }, 'retrieval: dropped candidate — URL is not a specific article');
      continue;
    }
    unique.push(candidate);
  }
  return unique;
}

function selectSearches(searches, topic) {
  const wantedCountries = new Set(countriesInTopic(topic || ''));
  const topicLower = String(topic || '').toLowerCase();
  return [...searches]
    .map((search) => ({ search, score: searchScore(search, wantedCountries, topicLower) }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return String(a.search.label || '').localeCompare(String(b.search.label || ''));
    })
    .slice(0, MAX_TARGETED_SEARCHES)
    .map((entry) => entry.search);
}

// Lower score sorts earlier. Searches whose outlets represent a country named in
// the topic, or whose topic_signals match the topic, get a relevance lift so
// they survive the MAX_TARGETED_SEARCHES cut instead of losing to alphabetical
// order.
function searchScore(search, wantedCountries, topicLower) {
  const priority = PRIORITY_ORDER[search.priority] ?? 9;
  let lift = 0;
  if (searchRepresentsWantedCountry(search, wantedCountries)) lift += 2;
  if ((search.topic_signals || []).some((signal) => topicLower.includes(signal))) lift += 2;
  return priority - lift;
}

function searchRepresentsWantedCountry(search, wantedCountries) {
  if (wantedCountries.size === 0) return false;
  const query = String(search.query || '').toLowerCase();
  return COUNTRY_SIGNALS.some((entry) =>
    wantedCountries.has(entry.country) &&
    entry.sourceSignals.some((signal) => query.includes(signal))
  );
}

async function queryBraveSearch(query, logger, freshness = 'pw') {
  const params = new URLSearchParams({
    q: query,
    count: String(BRAVE_RESULT_COUNT),
    freshness,
    spellcheck: '1',
    search_lang: 'en'
  });
  const response = await requestJson(`${BRAVE_SEARCH_ENDPOINT}?${params.toString()}`, {
    timeoutMs: 2500,
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
    }
  });

  if (!response.ok) {
    logger.warn({ error: response.error }, 'retrieval: Brave search query failed — skipping this source');
    return ok([]);
  }

  const articles = response.value.json.web?.results || [];
  return ok(articles.map((result) => ({
    url: result.url,
    title: result.title,
    // Prefer Brave's absolute page_age; fall back to the relative "age" string.
    seendate: normalizePublishedAt(result.page_age || result.age)
  })));
}

function normalizePublishedAt(value) {
  if (!value) return null;
  const direct = new Date(value).getTime();
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const relative = parseRelativeAge(String(value));
  // Return null (not "now") when the age is unknown, so an undated source ranks
  // as oldest in the recency tiebreak instead of masquerading as the newest.
  return relative ? relative.toISOString() : null;
}

const RELATIVE_AGE_MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};

function parseRelativeAge(value) {
  const match = value.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);
  if (!match) return null;
  const ms = RELATIVE_AGE_MS[match[2].toLowerCase()];
  if (!ms) return null;
  return new Date(Date.now() - Number(match[1]) * ms);
}

async function articleToSource(topic, article, search, logger) {
  const html = await requestText(article.url, { timeoutMs: 2800 });
  if (!html.ok) {
    logger.debug({ label: search.label, url: article.url, error: html.error }, 'retrieval: dropped source — article fetch failed');
    return null;
  }

  const extracted = extractArticle(html.value.body);
  if (!extracted.ok) {
    logger.debug({ label: search.label, url: article.url, error: extracted.error }, 'retrieval: dropped source — could not extract article text');
    return null;
  }
  if (!String(extracted.value.extractedText || '').trim()) {
    logger.debug({ label: search.label, url: article.url }, 'retrieval: dropped source — extracted text was empty');
    return null;
  }

  const source = {
    source_name: search.label,
    source_type: search.source_type,
    url: article.url,
    published_at: article.seendate || null,
    title: article.title || extracted.value.title,
    extracted_text: extracted.value.extractedText,
    word_count: extracted.value.wordCount,
    quotes: extracted.value.quotes,
    language: extracted.value.language,
    state_media: Boolean(search.state_media),
    priority: search.priority || 'medium'
  };

  const validation = validateRetrievedSource(source, topic);
  if (!validation.ok) {
    logger.debug({ label: search.label, url: article.url, reason: validation.reason }, 'retrieval: dropped source — failed validity filter');
    return null;
  }

  // Measured topic relevance (title hits weigh double), not search-result order.
  source.relevance_score = validation.relevance;
  return source;
}

module.exports = { fetchTargetedSources, selectSearches };
