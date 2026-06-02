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

  // Serve index.html
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
      let parsed;
      try { parsed = JSON.parse(body); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request' })); return; }

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

      // Set up streaming response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // Send a heartbeat every 15 seconds to keep connection alive
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 15000);

      const apiReq = https.request(options, (apiRes) => {
        let fullText = '';

        apiRes.on('data', chunk => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                // Collect text deltas
                if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                  fullText += parsed.delta.text;
                  // Send progress to client
                  res.write(`data: ${JSON.stringify({ type: 'progress', text: parsed.delta.text })}\n\n`);
                }
                // Stream done
                if (parsed.type === 'message_stop') {
                  clearInterval(heartbeat);
                  res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
                  res.end();
                }
                // Handle errors
                if (parsed.type === 'error') {
                  clearInterval(heartbeat);
                  res.write(`data: ${JSON.stringify({ type: 'error', message: parsed.error?.message || 'API error' })}\n\n`);
                  res.end();
                }
              } catch(e) { /* skip unparseable lines */ }
            }
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

server.timeout = 0; // No timeout - streaming handles this
server.listen(PORT, () => {
  console.log(`Contxt server running on port ${PORT}`);
});
