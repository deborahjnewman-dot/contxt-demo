const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env');
const { createLlmClient, modelChain } = require('./llm');
const { buildModelRequest } = require('./brief-request');
const { createLogger } = require('./logger');
const { prepareBriefOutput } = require('./brief-output');

loadEnv();

const PORT = process.env.PORT || 3000;
const LLM_API_KEY = process.env.OPENROUTER_API_KEY;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_CACHE_ENTRIES = 200; // bound the in-memory cache so a long-lived process cannot leak
const MAX_BODY_BYTES = 64 * 1024;
const briefCache = new Map(); // Map<normalizedTopic, { fullText, createdAt }>
const inFlight = new Map(); // Map<normalizedTopic, Promise> — concurrent identical topics share one pipeline run
const logger = createLogger({ service: 'contxt-server' });
const llm = createLlmClient(LLM_API_KEY);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/brief') {
    handleBrief(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/precache') {
    handlePrecache(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

async function handleBrief(req, res) {
  if (!ensureConfigured(res)) return;

  const topic = await readTopic(req, res);
  if (!topic) return;

  const startedAt = Date.now();
  logger.info({ topic }, 'brief: request received');
  const cached = getCachedBrief(topic);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  if (cached) {
    logger.info({ topic, elapsed_ms: Date.now() - startedAt }, 'brief: served from cache');
    res.write(`data: ${JSON.stringify({ type: 'done', fullText: cached.fullText })}\n\n`);
    res.end();
    return;
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    const result = await generateBrief(topic);
    clearInterval(heartbeat);
    if (res.writableEnded) return;

    if (result.status === 'no_coverage') {
      logger.info({ topic, reason: result.payload.reason, elapsed_ms: Date.now() - startedAt }, 'brief: no coverage — skipped model generation');
      res.write(`data: ${JSON.stringify({ type: 'done', fullText: JSON.stringify(result.payload) })}\n\n`);
    } else {
      logger.info({ topic, cached: result.cacheable, elapsed_ms: Date.now() - startedAt }, 'brief: completed');
      res.write(`data: ${JSON.stringify({ type: 'done', fullText: result.text })}\n\n`);
    }
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    logger.error({ topic, error: err.message, elapsed_ms: Date.now() - startedAt }, 'brief: FAILED — generation error');
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
}

async function handlePrecache(req, res) {
  if (!ensureConfigured(res)) return;

  const topic = await readTopic(req, res);
  if (!topic) return;

  logger.info({ topic }, 'precache: request received');
  try {
    const result = await generateBrief(topic);
    if (result.status === 'no_coverage') {
      logger.info({ topic, reason: result.payload.reason }, 'precache: no coverage — nothing cached');
      sendJson(res, 200, result.payload);
      return;
    }

    logger.info({ topic, cached: result.cacheable, bytes: result.text.length }, 'precache: completed');
    sendJson(res, 200, { topic, cached: result.cacheable, bytes: result.text.length });
  } catch (err) {
    logger.error({ topic, error: err.message }, 'precache: FAILED');
    sendJson(res, 500, { error: err.message });
  }
}

// Runs retrieval + generation + validation once per topic, no matter how many
// concurrent requests ask for it.
function generateBrief(topic) {
  const key = cacheKey(topic);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = runBriefPipeline(topic).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function runBriefPipeline(topic) {
  const modelRequest = await buildModelRequest(topic, logger);
  if (modelRequest.status === 'no_coverage') {
    return { status: 'no_coverage', payload: modelRequest };
  }

  logger.info({ topic, sources: modelRequest.sourceCount, quotes: modelRequest.quoteCount }, 'brief: generating from sources');
  const modelStartedAt = Date.now();
  let prepared = prepareBriefOutput(await llm.collectMessage(modelRequest), modelRequest.retrievedSources);
  if (!prepared.ok) {
    // One corrective retry: tell the model what failed instead of giving up.
    logger.warn({ topic, error: prepared.error }, 'brief: validation failed — retrying once with feedback');
    const retryRequest = withValidationFeedback(modelRequest, prepared.error);
    prepared = prepareBriefOutput(await llm.collectMessage(retryRequest), modelRequest.retrievedSources);
  }
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }

  // Only cache real, populated briefs. Caching a no-coverage/empty result
  // would pin it under this topic for CACHE_TTL_MS even though a retry
  // could succeed.
  if (prepared.cacheable) setCachedBrief(topic, prepared.text);
  logger.info({ topic, model_ms: Date.now() - modelStartedAt, cached: prepared.cacheable }, 'brief: model output validated');
  return { status: 'ok', text: prepared.text, cacheable: prepared.cacheable };
}

function withValidationFeedback(modelRequest, error) {
  return {
    ...modelRequest,
    messages: [
      ...modelRequest.messages,
      { role: 'user', content: `Your previous brief was rejected: ${error} Regenerate the brief from the same sources, strictly following every rule.` }
    ]
  };
}

function ensureConfigured(res) {
  if (LLM_API_KEY) return true;
  sendJson(res, 500, { error: 'API key not configured' });
  return false;
}

async function readTopic(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    logger.warn({ error: error.message }, 'rejected — request body was not valid JSON');
    sendJson(res, 400, { error: 'Invalid request: ' + error.message });
    return null;
  }

  const topic = String(parsed.topic || '').trim();
  if (!topic) {
    logger.warn({}, 'rejected — no topic provided');
    sendJson(res, 400, { error: 'topic is required' });
    return null;
  }
  return topic;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', (error) => reject(error));
  });
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Long enough for the slowest legitimate brief; heartbeats reset it. Never 0 —
// that would let dead or malicious connections hold sockets forever.
server.timeout = 120000;
server.listen(PORT, () => {
  logger.info({
    port: PORT,
    brave_search: process.env.BRAVE_SEARCH_API_KEY ? 'configured' : 'MISSING',
    openrouter: LLM_API_KEY ? 'configured' : 'MISSING',
    model: modelChain()[0]
  }, 'server: started and listening');
});

function cacheKey(topic) {
  return String(topic || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')        // collapse internal whitespace
    .replace(/[?!.]+$/, '')      // drop trailing punctuation
    .trim();
}

function getCachedBrief(topic) {
  const key = cacheKey(topic);
  const cached = briefCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    briefCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedBrief(topic, fullText) {
  if (!topic || !fullText) return;
  const key = cacheKey(topic);
  // FIFO eviction once the cache is full (Map preserves insertion order).
  if (!briefCache.has(key) && briefCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = briefCache.keys().next().value;
    if (oldestKey !== undefined) briefCache.delete(oldestKey);
  }
  briefCache.set(key, {
    fullText,
    createdAt: Date.now()
  });
}
