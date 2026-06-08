const fs = require('fs');
const path = require('path');
const { requestJson, requestText } = require('./http');
const { extractArticle } = require('./extract');
const { translateToEnglish } = require('./translate');
const { ok } = require('./result');

const SOURCES_PATH = path.join(__dirname, 'sources.json');
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

function readSourceConfig(logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
    return Array.isArray(parsed.searches) ? parsed.searches : [];
  } catch (error) {
    logger.warn({ error: error.message }, 'sources config unavailable');
    return [];
  }
}

async function fetchTargetedSources(topic, logger) {
  const searches = readSourceConfig(logger);
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    logger.warn({ search_count: searches.length }, 'brave search api key unavailable');
    return ok([]);
  }

  const results = await Promise.all(searches.map((search) => {
    return fetchSearchSources(topic, search, logger.child({ search: search.label }));
  }));

  return ok(results.flat());
}

async function fetchSearchSources(topic, search, logger) {
  const query = `${topic} ${search.query}`;
  const searchResult = await queryBraveSearch(query, logger);
  if (!searchResult.ok) return [];

  const sources = await Promise.all(searchResult.value.map((article, index) => {
    return articleToSource(article, search, index, logger);
  }));
  return sources.filter(Boolean);
}

async function queryBraveSearch(query, logger) {
  const params = new URLSearchParams({
    q: query,
    count: '6',
    freshness: 'pm',
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
    logger.warn({ error: response.error }, 'brave search query failed');
    return ok([]);
  }

  const articles = response.value.json.web?.results || [];
  return ok(articles.map((result) => ({
    url: result.url,
    title: result.title,
    seendate: normalizePublishedAt(result.age)
  })));
}

function normalizePublishedAt(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

async function articleToSource(article, search, index, logger) {
  if (!article.url) return null;

  const html = await requestText(article.url, { timeoutMs: 2800 });
  if (!html.ok) {
    logger.debug({ label: search.label, url: article.url, error: html.error }, 'targeted article fetch failed');
    return null;
  }

  const extracted = extractArticle(html.value.body);
  if (!extracted.ok) {
    logger.debug({ label: search.label, url: article.url, error: extracted.error }, 'targeted article extraction skipped');
    return null;
  }

  const source = {
    source_name: search.label,
    source_type: search.source_type,
    url: article.url,
    published_at: article.seendate || new Date().toISOString(),
    title: article.title || extracted.value.title,
    extracted_text: extracted.value.extractedText,
    quotes: extracted.value.quotes,
    language: extracted.value.language,
    translated: false,
    relevance_score: Math.max(0.1, 0.9 - index * 0.05),
    priority: search.priority || 'medium'
  };

  const translated = await translateToEnglish(source, logger);
  return translated.ok ? translated.value : source;
}

module.exports = { fetchTargetedSources };
