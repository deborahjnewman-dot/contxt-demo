const { currentUtcDay } = require('./current-date');

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

function prepareBriefOutput(fullText, retrievedSources) {
  const normalizedText = normalizeBriefJsonText(fullText);
  if (!normalizedText) {
    return {
      ok: false,
      error: 'Brief generation returned an empty response.'
    };
  }

  try {
    const brief = JSON.parse(normalizedText);
    const validated = validateBrief(brief, retrievedSources);
    return {
      ok: true,
      text: JSON.stringify(validated),
      // A brief is only worth caching if it survived validation as a real,
      // populated brief. No-coverage conversions (synthetic labels, empty URLs)
      // and briefs gutted to nothing by validation must not be pinned for hours.
      cacheable: validated.status !== 'no_coverage' && !isEmptyBrief(validated)
    };
  } catch (error) {
    return {
      ok: false,
      error: 'Brief generation returned invalid JSON.'
    };
  }
}

function isEmptyBrief(brief) {
  if (!brief || typeof brief !== 'object') return true;
  const counts = [
    brief.confirmed?.facts,
    brief.claimed?.positions,
    brief.disputed?.fights,
    brief.unknown?.gaps
  ].reduce((total, arr) => total + (Array.isArray(arr) ? arr.length : 0), 0);
  return counts === 0;
}

const SYNTHETIC_LABEL_PATTERNS = [
  /contxt retrieval system/i,
  /contxt source log/i,
  /retrieval result/i,
  /retrieval insufficient/i,
  /contxt source/i,
  /retrieved sources? overview/i,
  /retrieved source set/i,
  /source set/i
];
const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};
const MONTH_PATTERN = Object.keys(MONTHS).join('|');

function validateBrief(brief, retrievedSources) {
  if (!brief || typeof brief !== 'object') {
    throw new Error('Brief is not an object.');
  }

  const validated = {
    ...brief,
    sources: normalizeSourceFlags(validateSourceList(brief.sources)),
    confirmed: validateConfirmedSection(brief.confirmed),
    claimed: validateClaimedSection(brief.claimed, quoteHaystack(retrievedSources)),
    disputed: validateDisputedSection(brief.disputed),
    unknown: validateUnknownSection(brief.unknown)
  };

  if (isEmptyBrief(validated) && (hasSyntheticSourceLabel(brief) || hasEmptySourceUrl(brief))) {
    return noCoverageBrief('Synthetic or incomplete source labels were generated.');
  }

  return validated;
}

// Deterministic domain -> flag mapping. Flags were previously a model decision
// and came out inconsistent (Al Jazeera as US, Reuters as a globe variant).
const DOMAIN_FLAGS = [
  [/(^|\.)aljazeera\.com$/, '🇶🇦'],
  [/(^|\.)reuters\.com$/, '🌐'],
  [/(^|\.)bbc\.(com|co\.uk)$/, '🇬🇧'],
  [/(^|\.)theguardian\.com$/, '🇬🇧'],
  [/(^|\.)apnews\.com$/, '🇺🇸'],
  [/(^|\.)(whitehouse|state|defense|congress)\.gov$/, '🇺🇸'],
  [/(^|\.)(un|ohchr)\.org$/, '🇺🇳'],
  [/(^|\.)icc-cpi\.int$/, '🇺🇳'],
  [/(^|\.)kremlin\.ru$/, '🇷🇺'],
  [/(^|\.)mid\.ru$/, '🇷🇺'],
  [/(^|\.)irna\.ir$/, '🇮🇷'],
  [/(^|\.)xinhuanet\.com$/, '🇨🇳'],
  [/(^|\.)fmprc\.gov\.cn$/, '🇨🇳'],
  [/(^|\.)nhk\.or\.jp$/, '🇯🇵'],
  [/(^|\.)wafa\.ps$/, '🇵🇸'],
  [/(^|\.)(haaretz\.com|timesofisrael\.com|gov\.il)$/, '🇮🇱'],
  [/(^|\.)(kyivindependent\.com|gov\.ua)$/, '🇺🇦'],
  [/(^|\.)(dawn\.com|geo\.tv|gov\.pk)$/, '🇵🇰'],
  [/(^|\.)(thehindu\.com|ndtv\.com|gov\.in)$/, '🇮🇳'],
  [/(^|\.)scmp\.com$/, '🇭🇰'],
  [/(^|\.)(asia\.)?nikkei\.com$/, '🇯🇵'],
  [/(^|\.)japantimes\.co\.jp$/, '🇯🇵'],
  [/(^|\.)dw\.com$/, '🇩🇪'],
  [/(^|\.)(france24\.com|afp\.com)$/, '🇫🇷'],
  [/(^|\.)middleeasteye\.net$/, '🇬🇧'],
  [/(^|\.)aawsat\.com$/, '🇸🇦'],
  [/(^|\.)icrc\.org$/, '🇨🇭'],
  [/(^|\.)(hrw\.org|aclu\.org|stripes\.com|militarytimes\.com)$/, '🇺🇸'],
  [/(^|\.)amnesty\.org$/, '🇬🇧'],
  [/(^|\.)who\.int$/, '🇺🇳']
];

function flagForUrl(url) {
  let hostname;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch (error) {
    return '';
  }
  for (const [pattern, flag] of DOMAIN_FLAGS) {
    if (pattern.test(hostname)) return flag;
  }
  return '';
}

function normalizeSourceFlags(sources) {
  if (!Array.isArray(sources)) return sources;
  return sources.map((source) => {
    const flag = flagForUrl(source && source.url);
    return flag ? { ...source, flag } : source;
  });
}

function validateSourceList(sources) {
  if (!Array.isArray(sources)) return sources;
  return sources.filter((source) => hasValidRequiredSource(source?.name, source?.url));
}

function hasSyntheticSourceLabel(brief) {
  const labels = [
    ...(brief.sources || []).map((source) => source.name),
    ...(brief.confirmed?.facts || []).map((fact) => fact.source),
    ...(brief.claimed?.positions || []).map((position) => position.source),
    ...(brief.disputed?.fights || []).flatMap((fight) => [fight.side1_source, fight.side2_source])
  ];

  return labels.some(isSyntheticSourceLabel);
}

function hasEmptySourceUrl(brief) {
  const urls = [
    ...(brief.sources || []).map((source) => source.url),
    ...(brief.confirmed?.facts || []).map((fact) => fact.url),
    ...(brief.claimed?.positions || []).map((position) => position.url),
    ...(brief.disputed?.fights || []).flatMap((fight) => [fight.side1_url, fight.side2_url])
  ];

  return urls.some((url) => !String(url || '').trim());
}

function isSyntheticSourceLabel(label) {
  const value = String(label || '').trim();
  return Boolean(value && SYNTHETIC_LABEL_PATTERNS.some((pattern) => pattern.test(value)));
}

function hasValidRequiredSource(source, url) {
  return Boolean(String(url || '').trim() && !isSyntheticSourceLabel(source));
}

function validateClaimedSection(claimed = {}, haystack = null) {
  const positions = Array.isArray(claimed.positions) ? claimed.positions : [];
  return {
    ...claimed,
    positions: dedupeBySpeaker(positions.map((position) => {
      if (!position.quote) return position;
      if (wordCount(position.quote) < 10 || !isVerbatimQuote(position.quote, haystack)) {
        return { ...position, quote: '', attribution: '' };
      }
      return position;
    })
      .filter((position) => hasValidRequiredSource(position.source, position.url))
      .filter((position) => !hasInvalidGeneratedDate(position, ['bold', 'text', 'quote', 'attribution'])))
  };
}

// "What each side says" needs different sides: keep only the first position
// from any given speaker (attribution name, falling back to the bold lead-in).
function dedupeBySpeaker(positions) {
  const seen = new Set();
  return positions.filter((position) => {
    const name = String(position.attribution || '').split(',')[0] || String(position.bold || '');
    const speaker = normalizeForMatch(name).split(' ').slice(0, 2).join(' ');
    if (!speaker) return true;
    if (seen.has(speaker)) return false;
    seen.add(speaker);
    return true;
  });
}

// Deterministic verbatim check: a quote only survives if it literally appears
// in the retrieved source text. Prompt rules ask for this; this enforces it.
function quoteHaystack(retrievedSources) {
  if (!Array.isArray(retrievedSources) || retrievedSources.length === 0) return null;
  const parts = [];
  for (const source of retrievedSources) {
    parts.push(source.extracted_text || '');
    for (const quote of source.quotes || []) parts.push(quote.text || '');
  }
  return normalizeForMatch(parts.join(' '));
}

function isVerbatimQuote(quote, haystack) {
  if (haystack === null) return true; // no source text available to check against
  const needle = normalizeForMatch(quote);
  return Boolean(needle) && haystack.includes(needle);
}

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function validateDisputedSection(disputed = {}) {
  const fights = Array.isArray(disputed.fights) ? disputed.fights : [];
  return {
    ...disputed,
    fights: fights
      .filter(isValidDispute)
      .filter((fight) => hasValidRequiredSource(fight.side1_source, fight.side1_url))
      .filter((fight) => hasValidRequiredSource(fight.side2_source, fight.side2_url))
      .filter((fight) => !hasInvalidGeneratedDate(fight, ['question', 'side1', 'side2']))
  };
}

function validateConfirmedSection(confirmed = {}) {
  const facts = Array.isArray(confirmed.facts) ? confirmed.facts : [];
  return {
    ...confirmed,
    facts: facts
      .filter((fact) => hasValidRequiredSource(fact.source, fact.url))
      .filter((fact) => !hasInvalidGeneratedDate(fact, ['bold', 'text']))
  };
}

// Meta-commentary about the retrieval system ("Retrieved sources do not
// specify...") is system talk, not news. Unknown gaps must read as open
// questions about the story.
const META_GAP_PATTERN = /\b(retriev(?:ed|al)|source (?:text|set|material|log)|sources? (?:above|do(?:es)? not|provided|here)|geographic coverage)\b/i;

function validateUnknownSection(unknown = {}) {
  const gaps = Array.isArray(unknown.gaps) ? unknown.gaps : [];
  return {
    ...unknown,
    gaps: gaps
      .filter((gap) => !hasInvalidGeneratedDate(gap, ['bold', 'text']))
      .filter((gap) => !META_GAP_PATTERN.test(`${gap?.bold || ''} ${gap?.text || ''}`))
      .map(sanitizeUnknownGapSource)
  };
}

function sanitizeUnknownGapSource(gap) {
  if (!gap) return gap;
  if (!gap.source || !gap.url || isSyntheticSourceLabel(gap.source)) {
    return { ...gap, source: '', url: '' };
  }
  return gap;
}

function isValidDispute(fight) {
  if (!fight) return false;
  if (!fight.side1_url || !fight.side2_url) return false;
  if (normalizeUrl(fight.side1_url) === normalizeUrl(fight.side2_url)) return false;

  const side1Entity = disputeEntity(fight.side1, fight.side1_source);
  const side2Entity = disputeEntity(fight.side2, fight.side2_source);
  if (side1Entity && side2Entity && side1Entity === side2Entity) return false;

  return true;
}

const KNOWN_ENTITIES = [
  ['united states', /\b(u\.?s\.?|united states|america|white house|pentagon|dhs)\b/],
  ['united nations', /\b(un|united nations|ohchr)\b/],
  ['israel', /\b(israel|israeli|idf)\b/],
  // No trailing boundary on "palestin" so it also matches "palestinian"/"palestine".
  ['palestine', /\b(palestin|hamas|gaza authority)/],
  ['russia', /\b(russia|russian|kremlin)\b/],
  ['ukraine', /\b(ukraine|ukrainian|kyiv)\b/],
  ['china', /\b(china|chinese|beijing)\b/],
  ['iran', /\b(iran|iranian|tehran)\b/]
];

function disputeEntity(sideText, sourceText) {
  const source = String(sourceText || '').toLowerCase();
  const side = String(sideText || '').toLowerCase();

  // The attributing source identifies who is making the claim. Key off it first
  // so that "Russia says Ukrainian forces..." (Kremlin) and "Ukraine says
  // Russian forces..." (Kyiv) are seen as two different entities, instead of
  // both collapsing to "russia" because it sits earlier in the list.
  const fromSource = matchKnownEntity(source);
  if (fromSource) return fromSource;

  // Fall back to the entity named earliest in the side text — typically the
  // subject doing the asserting ("Palestinian officials say Israeli strike...").
  const fromSide = earliestKnownEntity(side);
  if (fromSide) return fromSide;

  return cleanEntity(sourceText);
}

function matchKnownEntity(text) {
  for (const [entity, pattern] of KNOWN_ENTITIES) {
    if (pattern.test(text)) return entity;
  }
  return '';
}

function earliestKnownEntity(text) {
  let best = '';
  let bestIndex = Infinity;
  for (const [entity, pattern] of KNOWN_ENTITIES) {
    const match = pattern.exec(text);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      best = entity;
    }
  }
  return best;
}

function cleanEntity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\b(news|exclusive|report|article|statement|agency)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    return String(value || '').trim();
  }
}

function wordCount(value) {
  return (String(value || '').match(/\S+/g) || []).length;
}

// Past-tense / completed-action cues. A future date is only a problem when the
// text claims it already happened — mentioning a scheduled future event is fine.
// Deliberately no bare auxiliaries (was/were/had): they appear in almost any
// sentence and condemned legitimately scheduled events.
const COMPLETED_ACTION = /\b(killed|died|dead|happened|occurred|took place|concluded|ended|signed|announced|launched|struck|hit|reached|agreed|passed|voted|ruled|fired|destroyed|seized|captured|arrested|won|lost|resigned|withdrew|collapsed|erupted|completed|held)\b/i;

function hasInvalidGeneratedDate(item, fields) {
  const text = fields.map((field) => item?.[field] || '').join(' ');

  // A missing year is no longer grounds for removal — the model frequently omits
  // the obvious current year, and dropping the fact destroys good content.
  // Only flag a date that is explicitly in the future AND whose own sentence
  // describes it as already having happened.
  return extractVisibleDates(text).some((date) =>
    isFutureDate(date) && COMPLETED_ACTION.test(sentenceAround(text, date.raw))
  );
}

function sentenceAround(text, raw) {
  const index = text.indexOf(raw);
  if (index === -1) return text;
  const boundaries = ['. ', '! ', '? ', '; '];
  const start = Math.max(-1, ...boundaries.map((marker) => text.lastIndexOf(marker, index)));
  const ends = boundaries.map((marker) => text.indexOf(marker, index)).filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start + 1, end);
}

function extractVisibleDates(text) {
  const value = String(text || '');
  const dates = [];
  const monthDayPattern = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?!\\d)(?:,?\\s+(\\d{4}))?`, 'gi');
  const dayMonthPattern = new RegExp(`\\b(\\d{1,2})(?!\\d)\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?`, 'gi');
  const isoPattern = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;

  for (const match of value.matchAll(monthDayPattern)) {
    // Require a capitalized month, unless a year is attached. "march"/"may" as
    // lowercase verbs ("protesters march 30 km", "may 5 of the appeals") are not
    // dates; real generated dates are written "June 13", "May 5".
    if (!isCalendarMonth(match[1], match[3])) continue;
    dates.push({
      year: match[3] ? Number(match[3]) : null,
      month: MONTHS[match[1].toLowerCase()],
      day: Number(match[2]),
      missingYear: !match[3],
      raw: match[0]
    });
  }
  for (const match of value.matchAll(dayMonthPattern)) {
    if (!isCalendarMonth(match[2], match[3])) continue;
    dates.push({
      year: match[3] ? Number(match[3]) : null,
      month: MONTHS[match[2].toLowerCase()],
      day: Number(match[1]),
      missingYear: !match[3],
      raw: match[0]
    });
  }
  for (const match of value.matchAll(isoPattern)) {
    dates.push({
      year: Number(match[1]),
      month: Number(match[2]) - 1,
      day: Number(match[3]),
      missingYear: false,
      raw: match[0]
    });
  }

  return dates;
}

// A month token counts as a calendar month when it is capitalized (real dates
// are) or carries an explicit year. Lowercase "march"/"may" without a year are
// treated as ordinary verbs, not dates.
function isCalendarMonth(monthToken, yearToken) {
  if (yearToken) return true;
  return /^[A-Z]/.test(String(monthToken || ''));
}

function isFutureDate(date) {
  if (date.missingYear || !Number.isFinite(date.year)) return false;
  const candidate = Date.UTC(date.year, date.month, date.day);
  if (!Number.isFinite(candidate)) return false;
  const today = currentUtcDay();
  return candidate > today;
}

function noCoverageBrief(message) {
  return {
    status: 'no_coverage',
    reason: 'invalid_generated_sources',
    message
  };
}

module.exports = {
  hasEmptySourceUrl,
  hasInvalidGeneratedDate,
  hasSyntheticSourceLabel,
  hasValidRequiredSource,
  isSyntheticSourceLabel,
  isValidDispute,
  normalizeBriefJsonText,
  prepareBriefOutput,
  extractVisibleDates,
  validateBrief,
  wordCount
};
