const assert = require('assert');
const test = require('node:test');
const { retrieveSources } = require('../retrieval');

const silentLogger = {
  child() { return silentLogger; },
  debug() {},
  info() {},
  warn() {},
  error() {}
};

test('returns no reports before model generation when no valid sources are found', async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;

  try {
    const result = await retrieveSources('fabricated test topic', silentLogger);
    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'no_coverage');
    assert.equal(result.value.reason, 'no_reports');
    assert.equal(result.value.message, 'No reports on this topic.');
  } finally {
    if (originalKey) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});
