const https = require('https');

const DEFAULT_MODEL = 'openai/gpt-5.4';
const DEFAULT_FALLBACK_MODEL = 'anthropic/claude-sonnet-4.6';
// Streaming means this is a stall detector (max silence between chunks), not a
// cap on total generation time, so long briefs no longer hit a hard cliff.
const STREAM_IDLE_TIMEOUT_MS =
  Number(process.env.LLM_TIMEOUT_MS) ||
  Number(process.env.OPENROUTER_TIMEOUT_MS) ||
  25000;

function createLlmClient(apiKey) {
  return {
    collectMessage(requestBody) {
      return collectWithFallback(apiKey, requestBody);
    }
  };
}

async function collectWithFallback(apiKey, requestBody) {
  const models = modelChain(requestBody.model);
  let lastError;

  for (const model of models) {
    try {
      return await collectOpenRouter(apiKey, requestBody, model);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) break;
    }
  }

  throw lastError;
}

// Client errors (bad request, bad API key) fail identically on every model;
// only transient failures are worth a second attempt on the fallback model.
function isRetryable(error) {
  const status = error.statusCode;
  if (!Number.isFinite(status)) return true; // network error, timeout, stall, truncation
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

function llmError(message, statusCode) {
  const error = new Error(message);
  if (Number.isFinite(statusCode)) error.statusCode = statusCode;
  return error;
}

function collectOpenRouter(apiKey, requestBody, model) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const apiReq = https.request(openRouterOptions(apiKey), (apiRes) => {
      if (apiRes.statusCode >= 400) {
        let body = '';
        apiRes.setEncoding('utf8');
        apiRes.on('data', (chunk) => { body += chunk; });
        apiRes.on('end', () => {
          settle(reject, llmError(`OpenRouter HTTP ${apiRes.statusCode}: ${body.slice(0, 300)}`, apiRes.statusCode));
        });
        return;
      }

      let buffer = '';
      let text = '';
      let finishReason = null;
      apiRes.setEncoding('utf8');
      apiRes.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let event;
          try { event = JSON.parse(payload); } catch (error) { continue; }
          if (event.error) {
            apiReq.destroy();
            settle(reject, llmError(`OpenRouter stream error: ${event.error.message || JSON.stringify(event.error)}`, Number(event.error.code)));
            return;
          }
          const choice = event.choices?.[0];
          if (choice?.delta) text += extractMessageText(choice.delta.content);
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      });
      apiRes.on('end', () => {
        if (finishReason === 'length') {
          settle(reject, llmError('Brief generation was truncated (max_tokens reached).'));
        } else if (finishReason === 'content_filter') {
          settle(reject, llmError('The model declined to generate a brief for this topic.'));
        } else if (!text.trim()) {
          // An empty completion is a failure — never substitute transport data.
          settle(reject, llmError('The model returned an empty message.'));
        } else {
          settle(resolve, text);
        }
      });
    });

    // Socket inactivity covers connect time and mid-stream stalls alike; every
    // streamed chunk resets it.
    apiReq.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => apiReq.destroy(new Error('LLM request timed out')));
    apiReq.on('error', (error) => settle(reject, llmError(error.message)));
    apiReq.write(JSON.stringify(toOpenRouterRequest(requestBody, model)));
    apiReq.end();
  });
}

function toOpenRouterRequest(requestBody, modelOverride) {
  const schema = requestBody.response_format?.json_schema?.schema ||
    requestBody.output_config?.format?.schema;
  const messages = [];
  const system = systemContent(requestBody.system);

  if (system) messages.push({ role: 'system', content: system });
  messages.push(...(requestBody.messages || []).map((message) => ({
    role: message.role,
    content: flattenContent(message.content)
  })));

  const openRouterRequest = {
    model: normalizeModel(modelOverride || process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || requestBody.model),
    messages,
    max_tokens: requestBody.max_tokens,
    stream: true,
    provider: {
      require_parameters: true,
      sort: 'throughput'
    }
  };

  if (schema) {
    openRouterRequest.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'contxt_brief',
        strict: true,
        schema
      }
    };
  }

  const temperature = requestBody.temperature ?? 0.2;
  if (supportsTemperature(openRouterRequest.model)) {
    openRouterRequest.temperature = temperature;
  }

  return openRouterRequest;
}

function modelChain(model) {
  const primary = normalizeModel(process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || model || DEFAULT_MODEL);
  const fallback = normalizeModel(process.env.LLM_FALLBACK_MODEL || process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL);
  return [primary, fallback].filter((value, index, values) => value && values.indexOf(value) === index);
}

function normalizeModel(model) {
  const configured = model || DEFAULT_MODEL;
  const aliases = {
    'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4.6': 'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5'
  };
  return aliases[configured] || configured;
}

function supportsTemperature(model) {
  return !/^openai\/(gpt-5|o[34])/.test(model);
}

// Preserve content blocks (and their cache_control prompt-caching markers)
// instead of flattening the system prompt to a plain string.
function systemContent(system) {
  if (Array.isArray(system)) {
    const parts = system
      .map((part) => typeof part === 'string' ? { type: 'text', text: part } : part)
      .filter((part) => part && part.text);
    return parts.length ? parts : '';
  }
  return flattenContent(system);
}

function flattenContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text || '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

function openRouterOptions(apiKey) {
  return {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Contxt'
    }
  };
}

module.exports = {
  createLlmClient,
  isRetryable,
  modelChain,
  normalizeModel,
  toOpenRouterRequest
};
