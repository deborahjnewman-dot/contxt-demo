const https = require('https');

function createAnthropicClient(apiKey) {
  return {
    streamMessages(requestBody, clientRes, onDone) {
      return streamAnthropic(apiKey, requestBody, clientRes, onDone);
    },
    collectMessage(requestBody) {
      return collectAnthropic(apiKey, requestBody);
    }
  };
}

function streamAnthropic(apiKey, requestBody, clientRes, onDone) {
  return new Promise((resolve, reject) => {
    const apiReq = https.request(anthropicOptions(apiKey), (apiRes) => {
      let fullText = '';
      let inTextBlock = false;
      let errorBody = '';

      apiRes.on('data', chunk => {
        if (apiRes.statusCode >= 400) {
          errorBody += chunk.toString();
          return;
        }

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
                clientRes.write(`data: ${JSON.stringify({ type: 'progress', text })}\n\n`);
              }
            }
            if (evt.type === 'message_stop') {
              onDone(fullText);
              clientRes.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
              clientRes.end();
              resolve(fullText);
            }
            if (evt.type === 'error') {
              reject(new Error(evt.error?.message || 'API error'));
            }
          } catch(e) { /* skip malformed SSE fragments */ }
        }
      });

      apiRes.on('end', () => {
        if (apiRes.statusCode >= 400) {
          reject(new Error(`Anthropic HTTP ${apiRes.statusCode}: ${errorBody.slice(0, 300)}`));
          return;
        }
        if (!clientRes.writableEnded) clientRes.end();
        resolve(fullText);
      });
    });

    apiReq.on('error', reject);
    apiReq.write(JSON.stringify(requestBody));
    apiReq.end();
  });
}

function collectAnthropic(apiKey, requestBody) {
  return new Promise((resolve, reject) => {
    const apiReq = https.request(anthropicOptions(apiKey), (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode >= 400) {
          reject(new Error(`Anthropic HTTP ${apiRes.statusCode}: ${data.slice(0, 300)}`));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content || [])
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('');
          resolve(text || data);
        } catch (error) {
          reject(error);
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(JSON.stringify({ ...requestBody, stream: false }));
    apiReq.end();
  });
}

function anthropicOptions(apiKey) {
  return {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };
}

module.exports = { createAnthropicClient };
