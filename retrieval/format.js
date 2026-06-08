const { ok } = require('./result');

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const MAX_SOURCE_TEXT_CHARS = 8000;

function formatForModel(topic, resultSets) {
  const merged = resultSets.flat();
  const byUrl = new Map();

  for (const source of merged) {
    if (!source.url || byUrl.has(source.url)) continue;
    byUrl.set(source.url, source);
  }

  const sources = [...byUrl.values()]
    .sort(compareSources)
    .slice(0, 15);

  const internationalFound = sources.some(hasInternationalCoverage);
  const packageText = buildPackageText(topic, sources, internationalFound);

  return ok({
    sources,
    sourceCount: sources.length,
    quoteCount: sources.reduce((count, source) => count + source.quotes.length, 0),
    internationalFound,
    packageText
  });
}

function compareSources(a, b) {
  const priority = (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
  if (priority !== 0) return priority;

  const relevance = b.relevance_score - a.relevance_score;
  if (relevance !== 0) return relevance;

  return toTimestamp(b.published_at) - toTimestamp(a.published_at);
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hasInternationalCoverage(source) {
  if (source.language !== 'en' || source.translated) return true;

  const haystack = `${source.source_name || ''} ${source.url || ''}`.toLowerCase();
  return [
    'aljazeera.com',
    'bbc.com',
    'un.org',
    'ohchr.org',
    'icc-cpi.int',
    'reuters.com',
    'international'
  ].some((signal) => haystack.includes(signal));
}

function buildPackageText(topic, sources, internationalFound) {
  const lines = [
    `RETRIEVED SOURCES - ${new Date().toISOString()}`,
    `Topic: ${topic}`,
    `International sources found: ${internationalFound ? 'YES' : 'NO'}`,
    ''
  ];

  sources.forEach((source, index) => {
    lines.push('---');
    lines.push(`SOURCE ${index + 1}`);
    lines.push(`Name: ${source.source_name}`);
    lines.push(`Type: ${source.source_type}`);
    lines.push(`URL: ${source.url}`);
    lines.push(`Published: ${source.published_at}`);
    lines.push(`Translated from ${source.language}: ${source.translated ? 'YES' : 'NO'}`);
    lines.push('');
    lines.push(`Title: ${source.title}`);
    lines.push('');
    lines.push('Content:');
    lines.push(limitSourceText(source.extracted_text));
    lines.push('');
    lines.push('Quotes found in this source:');
    if (source.quotes.length === 0) {
      lines.push('- None extracted');
    } else {
      source.quotes.forEach((quote) => {
        lines.push(`- "${quote.text}" - ${quote.speaker || 'speaker not identified'}, ${quote.context || 'source text'}`);
      });
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('INSTRUCTIONS TO MODEL:');
  lines.push('- Use only information from the sources above unless the server explicitly enabled fallback web search.');
  lines.push('- Quotes must be verbatim, exactly as they appear above.');
  lines.push('- Do not invent or paraphrase quotes.');
  lines.push('- If a quote is not in the sources above, do not include it.');
  lines.push('- Organize into confirmed/claimed/disputed/unknown framework.');
  lines.push('- Return ONLY valid JSON starting with { and ending with }.');

  return lines.join('\n');
}

function limitSourceText(text) {
  const value = String(text || '');
  if (value.length <= MAX_SOURCE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_SOURCE_TEXT_CHARS)}\n[Source text truncated by server: ${value.length} characters total]`;
}

module.exports = { formatForModel };
