const assert = require('assert');
const test = require('node:test');
const { extractQuotes } = require('../retrieval/extract');

test('extracts quote speaker from text before quote', () => {
  const text = 'The foreign ministry said, "We will continue talks until a durable ceasefire is agreed by all parties involved." More text follows.';
  const quotes = extractQuotes(text);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].speaker, 'The foreign ministry');
  assert.match(quotes[0].context, /foreign ministry said/);
});

test('extracts quote speaker from text after quote', () => {
  const text = '"We will continue talks until a durable ceasefire is agreed by all parties involved," Biden said after the meeting.';
  const quotes = extractQuotes(text);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].speaker, 'Biden');
});

test('filters quotes under ten words', () => {
  const quotes = extractQuotes('"Too short to use." The minister said.');
  assert.equal(quotes.length, 0);
});

test('does not stitch a fabricated quote across paragraphs (H4)', () => {
  const text = 'He said "this is fine.\n\nUnrelated paragraph with plenty of words here about other things.\n\nShe added later" and left.';
  const quotes = extractQuotes(text);
  // The unmatched opening quote must not produce a multi-paragraph quote.
  assert.equal(quotes.every((q) => !q.text.includes('Unrelated paragraph')), true);
});

test('extracts a clean single-paragraph quote (H4)', () => {
  const text = 'Officials said "the strikes were entirely lawful and proportionate under all applicable international law" on Tuesday.';
  const quotes = extractQuotes(text);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].text, 'the strikes were entirely lawful and proportionate under all applicable international law');
});
