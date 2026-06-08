const { requestJson } = require('./http');
const { requestText } = require('./http');
const { extractArticle } = require('./extract');
const { translateToEnglish } = require('./translate');
const { ok } = require('./result');
const { createRateLimiter, delay } = require('./throttle');

const GDELT_ENDPOINT = process.env.GDELT_DOC_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_MIN_INTERVAL_MS = 5000;   // GDELT free DOC API: 1 request / 5s per IP
const GDELT_TIMEOUT_MS = 10000;       // responses take 3-7s;
const GDELT_MAX_BACKOFF_MS = 30000;
const GDELT_CACHE_TTL_MS = 15 * 60 * 1000; // GDELT only refreshes every ~15 minutes

const gdeltLimiter = createRateLimiter(GDELT_MIN_INTERVAL_MS);
const gdeltCache = new Map();

async function fetchGdeltSources(topic, logger) {
  const response = await queryGdeltArticles(topic, 10, logger);
  const articles = response.value;
  const sources = await Promise.all(articles.map((article, index) => {
    return articleToSource(article, index, logger.child({ article_rank: index + 1 }));
  }));

  return ok(sources.filter(Boolean));
}

async function queryGdeltArticles(query, maxRecords, logger) {
  const cacheKey = `${query}|${maxRecords}`;
  const cached = readCache(cacheKey);
  if (cached) {
    logger.info({ article_count: cached.length }, 'gdelt cache hit');
    return ok(cached);
  }

  const encodedQuery = encodeURIComponent(query);
  const url = `${GDELT_ENDPOINT}?query=${encodedQuery}&mode=artlist&format=json&maxrecords=${maxRecords}&sort=hybridrel`;
  const response = await requestGdelt(url, logger);

  if (!response.ok) {
    logger.warn({ error: response.error }, 'gdelt query failed');
    return ok([]);
  }

  const articles = response.value.json.articles || [];
  writeCache(cacheKey, articles);
  return ok(articles);
}

async function articleToSource(article, index, logger) {
  if (!article.url) return null;

  const html = await requestText(article.url, { timeoutMs: 3500 });
  if (!html.ok) {
    logger.debug({ url: article.url, error: html.error }, 'gdelt article fetch failed');
    return null;
  }

  const extracted = extractArticle(html.value.body);
  if (!extracted.ok) {
    logger.debug({ url: article.url, error: extracted.error }, 'gdelt article extraction skipped');
    return null;
  }

  const source = {
    source_name: article.domain ? `${article.domain} via GDELT` : 'GDELT',
    source_type: 'news',
    url: article.url,
    published_at: article.seendate || new Date().toISOString(),
    title: article.title || extracted.value.title,
    extracted_text: extracted.value.extractedText,
    quotes: extracted.value.quotes,
    language: extracted.value.language,
    translated: false,
    relevance_score: Math.max(0.1, 0.85 - index * 0.04),
    priority: isInternationalArticle(article) ? 'high' : 'medium'
  };

  const translated = await translateToEnglish(source, logger);
  return translated.ok ? translated.value : source;
}

function isInternationalArticle(article) {
  const domain = String(article.domain || article.url || '').toLowerCase();
  return ['bbc.', 'aljazeera.', 'reuters.', 'apnews.', 'un.org', 'ohchr.org', 'icc-cpi.int']
    .some((signal) => domain.includes(signal));
}

// All GDELT API calls go through the shared rate limiter (>=5s apart) and retry
// once on a 429, honoring any Retry-After the server sends.
function requestGdelt(url, logger) {
  return gdeltLimiter.schedule(async () => {
    let response = await requestJson(url, { timeoutMs: GDELT_TIMEOUT_MS });
    if (isRateLimited(response)) {
      const backoffMs = retryAfterMs(response.error.headers) || GDELT_MIN_INTERVAL_MS;
      logger.warn({ backoff_ms: backoffMs }, 'gdelt rate limited; backing off and retrying once');
      await delay(backoffMs);
      response = await requestJson(url, { timeoutMs: GDELT_TIMEOUT_MS });
    }
    return response;
  });
}

function isRateLimited(response) {
  return !response.ok
    && response.error
    && response.error.code === 'http_status'
    && response.error.statusCode === 429;
}

function retryAfterMs(headers) {
  const value = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, GDELT_MAX_BACKOFF_MS);

  const dateMs = new Date(value).getTime();
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), GDELT_MAX_BACKOFF_MS));

  return 0;
}

function readCache(key) {
  const hit = gdeltCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > GDELT_CACHE_TTL_MS) {
    gdeltCache.delete(key);
    return null;
  }
  return hit.articles;
}

function writeCache(key, articles) {
  gdeltCache.set(key, { articles, cachedAt: Date.now() });
}

module.exports = { fetchGdeltSources, queryGdeltArticles };
