const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env');
const { createAnthropicClient } = require('./anthropic');
const { buildModelRequest } = require('./brief-request');
const { createLogger } = require('./logger');

loadEnv();

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const briefCache = new Map(); // In-memory cache: Map<normalizedTopic, { fullText, createdAt }>
const logger = createLogger({ service: 'contxt-server' });
const anthropic = createAnthropicClient(ANTHROPIC_API_KEY);

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
    if (!ANTHROPIC_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not configured' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      logger.info({ body_length: body.length }, 'brief request received');
      let parsed;
      try { parsed = JSON.parse(body); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request: ' + e.message })); return; }

      const topic = String(parsed.topic || '').trim();
      if (!topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'topic is required' }));
        return;
      }
      const cached = getCachedBrief(topic);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      if (cached) {
        logger.info({ topic }, 'serving cached brief');
        res.write(`data: ${JSON.stringify({ type: 'done', fullText: cached.fullText })}\n\n`);
        res.end();
        return;
      }

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 15000);

      try {
        const modelRequest = await buildModelRequest(topic, logger);
        if (modelRequest.status === 'no_coverage') {
          const fullText = JSON.stringify(modelRequest);
          res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
          res.end();
          clearInterval(heartbeat);
          return;
        }

        await anthropic.streamMessages(modelRequest, res, (fullText) => {
          setCachedBrief(topic, normalizeBriefJsonText(fullText));
        });
        clearInterval(heartbeat);
      } catch (err) {
        clearInterval(heartbeat);
        logger.error({ topic, error: err.message }, 'brief generation failed');
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          res.end();
        }
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/precache') {
    if (!ANTHROPIC_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not configured' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request: ' + e.message })); return; }

      const topic = String(parsed.topic || '').trim();
      if (!topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'topic is required' }));
        return;
      }

      try {
        const modelRequest = await buildModelRequest(topic, logger);
        if (modelRequest.status === 'no_coverage') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(modelRequest));
          return;
        }

        const fullText = await anthropic.collectMessage(modelRequest);
        const normalizedText = normalizeBriefJsonText(fullText);
        setCachedBrief(topic, normalizedText);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ topic, cached: true, bytes: normalizedText.length }));
      } catch (err) {
        logger.error({ topic, error: err.message }, 'precache failed');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.timeout = 0;
server.listen(PORT, () => {
  logger.info({ port: PORT }, 'server started');
});

function cacheKey(topic) {
  return String(topic || '').trim().toLowerCase();
}

function getCachedBrief(topic) {
  const cached = briefCache.get(cacheKey(topic));
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    briefCache.delete(cacheKey(topic));
    return null;
  }
  return cached;
}

function setCachedBrief(topic, fullText) {
  if (!topic || !fullText) return;
  briefCache.set(cacheKey(topic), {
    fullText,
    createdAt: Date.now()
  });
}

function normalizeBriefJsonText(fullText) {
  const trimmed = String(fullText || '').trim();
  if (!trimmed) return trimmed;

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return trimmed;

    const candidate = match[0].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (parseError) {
      return trimmed;
    }
  }
}
