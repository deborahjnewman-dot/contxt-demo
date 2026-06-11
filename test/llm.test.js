const assert = require('assert');
const test = require('node:test');
const { isRetryable, toOpenRouterRequest, modelChain } = require('../llm');

function requestBody(overrides = {}) {
  return {
    max_tokens: 100,
    system: [{ type: 'text', text: 'You are Contxt.', cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    messages: [{ role: 'user', content: 'topic' }],
    ...overrides
  };
}

test('does not retry client errors on the fallback model', () => {
  assert.equal(isRetryable(Object.assign(new Error('bad key'), { statusCode: 401 })), false);
  assert.equal(isRetryable(Object.assign(new Error('bad request'), { statusCode: 400 })), false);
  assert.equal(isRetryable(Object.assign(new Error('rate limited'), { statusCode: 429 })), true);
  assert.equal(isRetryable(Object.assign(new Error('server error'), { statusCode: 502 })), true);
  assert.equal(isRetryable(new Error('LLM request timed out')), true);
});

test('preserves system cache_control blocks instead of flattening', () => {
  const request = toOpenRouterRequest(requestBody(), 'openai/gpt-5.4');
  const system = request.messages[0];
  assert.equal(system.role, 'system');
  assert.deepEqual(system.content[0].cache_control, { type: 'ephemeral' });
  assert.equal(system.content[0].text, 'You are Contxt.');
});

test('requests streaming with strict json schema', () => {
  const request = toOpenRouterRequest(requestBody(), 'openai/gpt-5.4');
  assert.equal(request.stream, true);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.deepEqual(request.response_format.json_schema.schema, { type: 'object' });
});

test('accepts schema from either request shape without double nesting', () => {
  const viaResponseFormat = toOpenRouterRequest(requestBody({
    output_config: undefined,
    response_format: { json_schema: { schema: { type: 'object' } } }
  }), 'openai/gpt-5.4');
  assert.deepEqual(viaResponseFormat.response_format.json_schema.schema, { type: 'object' });
});

test('model chain falls back from primary to fallback once', () => {
  const chain = modelChain();
  assert.equal(chain.length, 2);
  assert.notEqual(chain[0], chain[1]);
});
