const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
    req.on('end', () => {
      console.log('Received body length:', body.length);
      console.log('Body preview:', body.substring(0, 100));
      let parsed;
      try { parsed = JSON.parse(body); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request: ' + e.message })); return; }

      const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        stream: true,
        system: parsed.system,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
        messages: parsed.messages
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 15000);

      const apiReq = https.request(options, (apiRes) => {
        let fullText = '';
        let inTextBlock = false;

        apiRes.on('data', chunk => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === 'content_block_start') {
                inTextBlock = evt.content_block?.type === 'text';
              }
              if (evt.type === 'content_block_delta' && inTextBlock) {
                const text = evt.delta?.text || '';
                if (text) {
                  fullText += text;
                  res.write(`data: ${JSON.stringify({ type: 'progress', text })}\n\n`);
                }
              }
              if (evt.type === 'message_stop') {
                clearInterval(heartbeat);
                res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
                res.end();
              }
              if (evt.type === 'error') {
                clearInterval(heartbeat);
                res.write(`data: ${JSON.stringify({ type: 'error', message: evt.error?.message || 'API error' })}\n\n`);
                res.end();
              }
            } catch(e) { /* skip */ }
          }
        });

        apiRes.on('end', () => {
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        });
      });

      apiReq.on('error', (err) => {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
      });

      apiReq.write(requestBody);
      apiReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.timeout = 0;
server.listen(PORT, () => {
  console.log(`Contxt server running on port ${PORT}`);
});
