const { ok } = require('./result');
const { currentDateString } = require('../current-date');

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const MAX_SOURCE_TEXT_CHARS = Number(process.env.MAX_SOURCE_TEXT_CHARS) || 1800;
const MAX_SOURCES_PER_DOMAIN = 3;
const MAX_FORMATTED_SOURCES = Number(process.env.MAX_FORMATTED_SOURCES) || 8;
// State media ranks below independent news so propaganda outlets never outrank
// AP/Reuters, while still being labeled honestly to the model.
const SOURCE_CLASS_WEIGHT = { primary: 3, wire: 2, independent: 1, state_media: 0 };
const COUNTRY_SIGNALS = [
  { country: 'United States', terms: ['united states', 'u.s.', 'us', 'america', 'american'], sourceSignals: ['whitehouse.gov', 'state.gov', 'defense.gov', 'congress.gov', 'courtlistener.com', 'justia.com'] },
  { country: 'United Kingdom', terms: ['united kingdom', 'uk', 'britain', 'british'], sourceSignals: ['bbc.com', 'bbc.co.uk', 'theguardian.com', 'gov.uk'] },
  { country: 'Israel', terms: ['israel', 'israeli'], sourceSignals: ['gov.il', 'mfa.gov.il', 'timesofisrael.com', 'haaretz.com'] },
  { country: 'Palestine', terms: ['palestine', 'palestinian', 'gaza', 'west bank'], sourceSignals: ['wafa.ps'] },
  { country: 'Egypt', terms: ['egypt', 'egyptian'], sourceSignals: ['mfa.gov.eg'] },
  { country: 'Iran', terms: ['iran', 'iranian'], sourceSignals: ['irna.ir', 'irangov.ir'] },
  { country: 'Russia', terms: ['russia', 'russian'], sourceSignals: ['kremlin.ru', 'mid.ru', 'meduza.io'] },
  { country: 'Ukraine', terms: ['ukraine', 'ukrainian'], sourceSignals: ['president.gov.ua', 'mfa.gov.ua', 'kyivindependent.com'] },
  { country: 'China', terms: ['china', 'chinese'], sourceSignals: ['fmprc.gov.cn', 'xinhuanet.com', 'scmp.com'] },
  { country: 'India', terms: ['india', 'indian'], sourceSignals: ['mea.gov.in', 'thehindu.com', 'ndtv.com'] },
  { country: 'Pakistan', terms: ['pakistan', 'pakistani'], sourceSignals: ['mofa.gov.pk', 'dawn.com', 'geo.tv'] },
  { country: 'Japan', terms: ['japan', 'japanese'], sourceSignals: ['nhk.or.jp', 'japantimes.co.jp', 'asia.nikkei.com'] },
  { country: 'Qatar', terms: ['qatar', 'qatari'], sourceSignals: ['aljazeera.com'] }
];

// Search-config labels ("US Government", "UN and International Bodies") are
// grouping labels, not outlet names. The model copies the Name: line into the
// brief, so map domains to the names a reader expects to see.
const DOMAIN_NAMES = {
  'state.gov': 'U.S. State Department',
  'whitehouse.gov': 'White House',
  'defense.gov': 'Pentagon',
  'congress.gov': 'U.S. Congress',
  'un.org': 'United Nations',
  'ohchr.org': 'UN Human Rights Office',
  'icc-cpi.int': 'International Criminal Court',
  'nato.int': 'NATO',
  'who.int': 'World Health Organization',
  'gov.il': 'Israeli Government',
  'mfa.gov.il': 'Israel Foreign Ministry',
  'wafa.ps': 'WAFA',
  'mfa.gov.eg': 'Egypt Foreign Ministry',
  'irna.ir': 'IRNA',
  'irangov.ir': 'Iranian Government',
  'president.gov.ua': "Ukraine President's Office",
  'mfa.gov.ua': 'Ukraine Foreign Ministry',
  'kremlin.ru': 'Kremlin',
  'mid.ru': 'Russia Foreign Ministry',
  'mea.gov.in': 'India External Affairs Ministry',
  'mofa.gov.pk': 'Pakistan Foreign Ministry',
  'fmprc.gov.cn': 'Chinese Foreign Ministry',
  'xinhuanet.com': 'Xinhua',
  'reliefweb.int': 'ReliefWeb',
  'msf.org': 'MSF',
  'worldbank.org': 'World Bank',
  'imf.org': 'IMF',
  'fifa.com': 'FIFA',
  'olympics.com': 'Olympics',
  'nasa.gov': 'NASA'
};

function displaySourceName(source) {
  const domain = sourceDomain(source.url);
  for (const [key, name] of Object.entries(DOMAIN_NAMES)) {
    if (domain === key || domain.endsWith(`.${key}`)) return name;
  }
  return source.source_name;
}

function formatForModel(topic, resultSets) {
  const merged = resultSets.flat();
  const byUrl = new Map();

  for (const source of merged) {
    if (!source.url || byUrl.has(source.url)) continue;
    if (!hasSourceContent(source)) continue;
    byUrl.set(source.url, source);
  }

  const sources = capSourcesPerDomain([...byUrl.values()].sort(compareSources))
    .slice(0, MAX_FORMATTED_SOURCES);

  const geographicCoverage = analyzeGeographicCoverage(topic, sources);
  const internationalFound = sources.some(hasInternationalCoverage);
  const packageText = buildPackageText(topic, sources, internationalFound, geographicCoverage);

  return ok({
    sources,
    sourceCount: sources.length,
    quoteCount: sources.reduce((count, source) => count + source.quotes.length, 0),
    internationalFound,
    geographicCoverage,
    packageText
  });
}

function compareSources(a, b) {
  const sourceClass = sourceClassWeight(b) - sourceClassWeight(a);
  if (sourceClass !== 0) return sourceClass;

  const priority = (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
  if (priority !== 0) return priority;

  const relevance = b.relevance_score - a.relevance_score;
  if (relevance !== 0) return relevance;

  return toTimestamp(b.published_at) - toTimestamp(a.published_at);
}

function sourceClassWeight(source) {
  return SOURCE_CLASS_WEIGHT[sourceClass(source)] || 0;
}

function sourceClass(source) {
  if (source.state_media) return 'state_media';
  const domain = sourceDomain(source.url);
  if (source.source_type === 'government' || source.source_type === 'civil_society') return 'primary';
  if (domain === 'apnews.com' || domain === 'reuters.com') return 'wire';
  return 'independent';
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function capSourcesPerDomain(sources) {
  const counts = new Map();
  const capped = [];

  for (const source of sources) {
    const domain = sourceDomain(source.url);
    if (domain) {
      const count = counts.get(domain) || 0;
      if (count >= MAX_SOURCES_PER_DOMAIN) continue;
      counts.set(domain, count + 1);
    }
    capped.push(source);
  }

  return capped;
}

function sourceDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (error) {
    return '';
  }
}

function hasInternationalCoverage(source) {
  if (source.language !== 'en') return true;

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

function hasSourceContent(source) {
  return String(source.extracted_text || '').trim().length > 0;
}

function buildPackageText(topic, sources, internationalFound, geographicCoverage) {
  const lines = [
    `RETRIEVED SOURCES - ${currentDateString()}`,
    `Topic: ${topic}`,
    `International sources found: ${internationalFound ? 'YES' : 'NO'}`,
    `Geographic coverage: ${formatGeographicCoverage(geographicCoverage)}`,
    ''
  ];

  sources.forEach((source, index) => {
    lines.push('---');
    lines.push(`SOURCE ${index + 1}`);
    lines.push(`Name: ${displaySourceName(source)}`);
    lines.push(`Type: ${source.source_type}`);
    lines.push(`Source class: ${sourceClass(source)}`);
    lines.push(`URL: ${source.url}`);
    lines.push(`Published: ${source.published_at || 'unknown'}`);
    lines.push(`Original language: ${source.language || 'auto'}`);
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

  // Behavioral rules live solely in the (cached) system prompt; the user
  // message carries only per-request source data.
  return lines.join('\n');
}

function analyzeGeographicCoverage(topic, sources) {
  const namedCountries = countriesInTopic(topic);
  const representedCountries = countriesInSources(sources);
  const missingCountries = namedCountries.filter((country) => !representedCountries.includes(country));

  return {
    namedCountries,
    representedCountries,
    missingCountries,
    sufficient: namedCountries.length <= 1 || missingCountries.length === 0
  };
}

function countriesInTopic(topic) {
  const value = String(topic || '').toLowerCase();
  return COUNTRY_SIGNALS
    .filter((entry) => entry.terms.some((term) => termMatches(value, term)))
    .map((entry) => entry.country);
}

// Word-boundary term match. Prevents "us" matching inside "virus" and "america"
// inside "panamerican". Boundaries are non-letters so "u.s." still matches.
function termMatches(text, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(text);
}

function countriesInSources(sources) {
  const found = new Set();
  for (const source of sources) {
    const haystack = `${source.source_name || ''} ${source.url || ''}`.toLowerCase();
    for (const entry of COUNTRY_SIGNALS) {
      if (entry.sourceSignals.some((signal) => haystack.includes(signal))) {
        found.add(entry.country);
      }
    }
  }
  return [...found];
}

function formatGeographicCoverage(coverage) {
  if (!coverage || coverage.namedCountries.length === 0) {
    return 'No named country requirement detected';
  }
  if (coverage.sufficient) {
    return `Represented ${coverage.representedCountries.join(', ') || 'none required'}`;
  }
  return `Missing perspective from ${coverage.missingCountries.join(', ')}`;
}

function limitSourceText(text) {
  const value = String(text || '');
  if (value.length <= MAX_SOURCE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_SOURCE_TEXT_CHARS)}\n[Source text truncated by server: ${value.length} characters total]`;
}

module.exports = {
  COUNTRY_SIGNALS,
  analyzeGeographicCoverage,
  countriesInSources,
  countriesInTopic,
  displaySourceName,
  formatForModel,
  hasSourceContent,
  capSourcesPerDomain,
  sourceClass,
  sourceDomain
};
