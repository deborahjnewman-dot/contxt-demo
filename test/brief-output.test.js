const assert = require('assert');
const test = require('node:test');
const {
  hasEmptySourceUrl,
  hasInvalidGeneratedDate,
  hasSyntheticSourceLabel,
  isValidDispute,
  normalizeBriefJsonText,
  prepareBriefOutput,
  extractVisibleDates,
  validateBrief,
  wordCount
} = require('../brief-output');

test('normalizes JSON wrapped in prose', () => {
  const wrapped = 'Here is the brief:\n{"topic":"Test","sources":[]}\nDone.';
  assert.equal(normalizeBriefJsonText(wrapped), '{"topic":"Test","sources":[]}');
});

test('rejects invalid generated output', () => {
  const prepared = prepareBriefOutput('not json');
  assert.equal(prepared.ok, false);
  assert.match(prepared.error, /invalid JSON/);
});

test('accepts valid generated JSON', () => {
  const prepared = prepareBriefOutput('{"topic":"Test","sources":[]}');
  assert.equal(prepared.ok, true);
  assert.equal(JSON.parse(prepared.text).topic, 'Test');
});

test('rejects synthetic source labels as no coverage', () => {
  const brief = {
    sources: [{ name: 'Contxt Retrieval System', url: 'https://example.com/story' }]
  };
  assert.equal(hasSyntheticSourceLabel(brief), true);
  assert.equal(validateBrief(brief).status, 'no_coverage');
});

test('detects empty source URLs', () => {
  assert.equal(hasEmptySourceUrl({
    sources: [{ name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' }],
    confirmed: { facts: [{ source: 'Reuters', url: '' }] }
  }), true);
});

test('sanitizes unsourced unknown gaps instead of rejecting the whole brief', () => {
  const prepared = prepareBriefOutput(JSON.stringify({
    topic: 'Japan inflation 2026',
    tag: 'Economy · Japan',
    confirmed: {
      headline: 'Known facts',
      facts: [{
        bold: 'AP reported GDP growth',
        text: 'Japan grew 2.1% annualized in January-March 2026.',
        source: 'AP',
        url: 'https://apnews.com/article/japan-gdp-economy-oil-war-spending-159ecf5e788ffa9379aba1973a3021f9'
      }]
    },
    claimed: { headline: 'Claims', positions: [] },
    disputed: { headline: 'Disputes', fights: [] },
    unknown: {
      headline: 'Unknowns',
      gaps: [{
        bold: 'Headline inflation missing',
        text: 'No national 2026 inflation rate has been published yet.',
        source: 'Retrieved sources overview',
        url: ''
      }]
    },
    sources: [{ flag: '🇺🇸', name: 'AP', url: 'https://apnews.com/article/japan-gdp-economy-oil-war-spending-159ecf5e788ffa9379aba1973a3021f9' }]
  }));

  assert.equal(prepared.ok, true);
  const brief = JSON.parse(prepared.text);
  assert.notEqual(brief.status, 'no_coverage');
  assert.equal(brief.unknown.gaps[0].source, '');
  assert.equal(brief.unknown.gaps[0].url, '');
});

test('filters poisoned generated citations without discarding valid facts', () => {
  const prepared = prepareBriefOutput(JSON.stringify({
    topic: 'Japan inflation 2026',
    tag: 'Economy · Japan',
    confirmed: {
      headline: 'Known facts',
      facts: [
        {
          bold: 'AP reported GDP growth',
          text: 'Japan grew 2.1% annualized in January-March 2026.',
          source: 'AP',
          url: 'https://apnews.com/article/japan-gdp-economy-oil-war-spending-159ecf5e788ffa9379aba1973a3021f9'
        },
        {
          bold: 'Retrieved source set reported prices',
          text: 'This item uses a placeholder citation.',
          source: 'Retrieved source set',
          url: ''
        }
      ]
    },
    claimed: {
      headline: 'Claims',
      positions: [{
        bold: 'Placeholder claim',
        text: 'This should not survive.',
        quote: '',
        attribution: '',
        source: 'Retrieved source set',
        url: ''
      }]
    },
    disputed: { headline: 'Disputes', fights: [] },
    unknown: { headline: 'Unknowns', gaps: [] },
    sources: [
      { flag: '🇺🇸', name: 'AP', url: 'https://apnews.com/article/japan-gdp-economy-oil-war-spending-159ecf5e788ffa9379aba1973a3021f9' },
      { flag: '', name: 'Retrieved source set', url: '' }
    ]
  }));

  assert.equal(prepared.ok, true);
  const brief = JSON.parse(prepared.text);
  assert.notEqual(brief.status, 'no_coverage');
  assert.equal(brief.confirmed.facts.length, 1);
  assert.equal(brief.claimed.positions.length, 0);
  assert.equal(brief.sources.length, 1);
});

test('clears claimed quotes under ten words', () => {
  const brief = validateBrief({
    sources: [{ name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' }],
    claimed: {
      positions: [{
        quote: 'Too short',
        attribution: 'Official',
        source: 'Reuters',
        url: 'https://reuters.com/world/story-2026-06-10/'
      }]
    }
  });

  assert.equal(brief.claimed.positions[0].quote, '');
  assert.equal(brief.claimed.positions[0].attribution, '');
});

test('removes disputes with same source URL or entity', () => {
  assert.equal(isValidDispute({
    side1: 'The U.S. said it was legal',
    side1_source: 'White House',
    side1_url: 'https://whitehouse.gov/briefing',
    side2: 'The Pentagon said it was legal',
    side2_source: 'Pentagon',
    side2_url: 'https://defense.gov/briefing'
  }), false);

  assert.equal(isValidDispute({
    side1: 'The U.S. said it was legal',
    side1_source: 'White House',
    side1_url: 'https://whitehouse.gov/briefing',
    side2: 'The UN called for review',
    side2_source: 'United Nations',
    side2_url: 'https://un.org/briefing'
  }), true);
});

test('counts quote words', () => {
  assert.equal(wordCount('one two three'), 3);
});

test('keeps genuine two-country disputes where each side names the other (H1)', () => {
  assert.equal(isValidDispute({
    side1: 'Russia says Ukrainian forces shelled the dam',
    side1_source: 'Kremlin statement',
    side1_url: 'https://kremlin.ru/a1',
    side2: 'Ukraine says Russian forces mined the dam',
    side2_source: 'Kyiv Independent',
    side2_url: 'https://kyivindependent.com/a2'
  }), true);

  assert.equal(isValidDispute({
    side1: 'Israel denies targeting the hospital',
    side1_source: 'IDF statement',
    side1_url: 'https://gov.il/x',
    side2: 'Palestinian officials say an Israeli strike hit the hospital',
    side2_source: 'WAFA',
    side2_url: 'https://wafa.ps/y'
  }), true);
});

test('normalizes source flags deterministically by domain (N7)', () => {
  const brief = validateBrief({
    sources: [
      { flag: '🇺🇸', name: 'Al Jazeera', url: 'https://www.aljazeera.com/news/story' },
      { flag: '🌍', name: 'Reuters', url: 'https://www.reuters.com/world/story-2026-06-10/' },
      { flag: '🇫🇷', name: 'BBC', url: 'https://www.bbc.com/news/articles/abc' }
    ]
  });
  assert.equal(brief.sources[0].flag, '🇶🇦');
  assert.equal(brief.sources[1].flag, '🌐');
  assert.equal(brief.sources[2].flag, '🇬🇧');
});

test('marks no-coverage and empty briefs as non-cacheable (C2)', () => {
  const populated = prepareBriefOutput(JSON.stringify({
    topic: 'T', tag: 'x',
    confirmed: { headline: 'h', facts: [{ bold: 'b', text: 't', source: 'AP', url: 'https://apnews.com/article/x-y' }] },
    claimed: { headline: 'h', positions: [] },
    disputed: { headline: 'h', fights: [] },
    unknown: { headline: 'h', gaps: [] },
    sources: [{ flag: '🇺🇸', name: 'AP', url: 'https://apnews.com/article/x-y' }]
  }));
  assert.equal(populated.ok, true);
  assert.equal(populated.cacheable, true);

  // One empty URL flips the brief to no_coverage -> must not be cached.
  const poisoned = prepareBriefOutput(JSON.stringify({
    topic: 'T', tag: 'x',
    confirmed: { headline: 'h', facts: [{ bold: 'b', text: 't', source: 'AP', url: '' }] },
    claimed: { headline: 'h', positions: [] },
    disputed: { headline: 'h', fights: [] },
    unknown: { headline: 'h', gaps: [] },
    sources: [{ flag: '🇺🇸', name: 'AP', url: 'https://apnews.com/article/x-y' }]
  }));
  assert.equal(poisoned.ok, true);
  assert.equal(poisoned.cacheable, false);

  // A structurally valid but fully empty brief is also non-cacheable.
  const empty = prepareBriefOutput(JSON.stringify({
    topic: 'T', tag: 'x',
    confirmed: { headline: 'h', facts: [] },
    claimed: { headline: 'h', positions: [] },
    disputed: { headline: 'h', fights: [] },
    unknown: { headline: 'h', gaps: [] },
    sources: [{ flag: '🇺🇸', name: 'AP', url: 'https://apnews.com/article/x-y' }]
  }));
  assert.equal(empty.cacheable, false);
});

test('keeps facts with missing-year dates (no longer dropped as invalid)', () => {
  const brief = validateBrief({
    sources: [{ name: 'Amnesty', url: 'https://example.com/story' }],
    confirmed: {
      facts: [
        { bold: 'Israel launched air strikes on June 13', text: 'according to Amnesty.', source: 'Amnesty', url: 'https://example.com/story' },
        { bold: 'Iran fired missiles on June 7 2026', text: 'according to AP.', source: 'AP', url: 'https://example.com/story' }
      ]
    }
  });

  // A missing year is not grounds for removal; both facts survive.
  assert.equal(brief.confirmed.facts.length, 2);
});

test('does not treat lowercase verbs "march"/"may" as dates', () => {
  assert.equal(hasInvalidGeneratedDate({ text: 'Protesters march 30 kilometers to the capital.' }, ['text']), false);
  assert.equal(hasInvalidGeneratedDate({ text: 'The court may 5 of the appeals dismiss.' }, ['text']), false);
});

test('keeps a scheduled future event but removes a future date claimed as already happened', () => {
  process.env.CONTXT_CURRENT_DATE = '2026-06-11';
  try {
    // Future date, but described as scheduled — must be kept.
    assert.equal(hasInvalidGeneratedDate({ text: 'Leaders will meet on July 15, 2026 in Cairo.' }, ['text']), false);
    // Future date claimed as completed — must be flagged.
    assert.equal(hasInvalidGeneratedDate({ text: 'The summit concluded on July 15, 2026.' }, ['text']), true);
  } finally {
    delete process.env.CONTXT_CURRENT_DATE;
  }
});

test('removes generated items with explicit future dates', () => {
  process.env.CONTXT_CURRENT_DATE = '2026-06-11';
  try {
    assert.equal(hasInvalidGeneratedDate({ text: 'The strike happened on June 13 2026.' }, ['text']), true);
    assert.equal(hasInvalidGeneratedDate({ text: 'The strike happened on June 10 2026.' }, ['text']), false);
  } finally {
    delete process.env.CONTXT_CURRENT_DATE;
  }
});

test('extracts visible dates for validation', () => {
  const dates = extractVisibleDates('On 13 June 2025 and 2026-06-10, officials met.');
  assert.deepEqual(dates.map((date) => date.raw), ['13 June 2025', '2026-06-10']);
});

test('blanks quotes that are not verbatim in the retrieved source text', () => {
  const retrievedSources = [{
    extracted_text: 'The minister spoke at length. "We will continue talks until a durable ceasefire is agreed by all parties involved," she said.',
    quotes: []
  }];
  const brief = JSON.parse(prepareBriefOutput(JSON.stringify({
    topic: 'T', tag: 'x',
    confirmed: { headline: 'h', facts: [] },
    claimed: {
      headline: 'h',
      positions: [
        {
          bold: 'Minister position', text: 't',
          quote: 'We will continue talks until a durable ceasefire is agreed by all parties involved',
          attribution: 'Minister, June 2026',
          source: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/'
        },
        {
          bold: 'Fabricated position', text: 't',
          quote: 'This exact sentence definitely never appeared in any retrieved source material at all',
          attribution: 'Minister, June 2026',
          source: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/'
        }
      ]
    },
    disputed: { headline: 'h', fights: [] },
    unknown: { headline: 'h', gaps: [] },
    sources: [{ flag: '', name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' }]
  }), retrievedSources).text);

  assert.equal(brief.claimed.positions[0].quote.startsWith('We will continue talks'), true);
  assert.equal(brief.claimed.positions[1].quote, '');
  assert.equal(brief.claimed.positions[1].attribution, '');
});

test('verbatim check tolerates punctuation and casing differences', () => {
  const retrievedSources = [{
    extracted_text: 'He said: "Every referee’s ambition is to go to the World Cup, and mine is no different."',
    quotes: []
  }];
  const brief = JSON.parse(prepareBriefOutput(JSON.stringify({
    topic: 'T', tag: 'x',
    confirmed: { headline: 'h', facts: [] },
    claimed: {
      headline: 'h',
      positions: [{
        bold: 'Referee position', text: 't',
        quote: "Every referee's ambition is to go to the World Cup, and mine is no different.",
        attribution: 'Artan, June 2026',
        source: 'AP', url: 'https://apnews.com/article/x-y'
      }]
    },
    disputed: { headline: 'h', fights: [] },
    unknown: { headline: 'h', gaps: [] },
    sources: [{ flag: '', name: 'AP', url: 'https://apnews.com/article/x-y' }]
  }), retrievedSources).text);

  assert.notEqual(brief.claimed.positions[0].quote, '');
});

test('quote check is skipped when no retrieved sources are provided', () => {
  const brief = validateBrief({
    sources: [{ name: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/' }],
    claimed: {
      positions: [{
        quote: 'A perfectly long quote of more than ten words that cannot be checked',
        attribution: 'Official',
        source: 'Reuters', url: 'https://reuters.com/world/story-2026-06-10/'
      }]
    }
  });
  assert.notEqual(brief.claimed.positions[0].quote, '');
});

test('a completed verb in another sentence does not condemn a scheduled future date', () => {
  process.env.CONTXT_CURRENT_DATE = '2026-06-11';
  try {
    // "announced" sits in a different sentence than the future date.
    assert.equal(hasInvalidGeneratedDate(
      { text: 'The deal was announced in May. Leaders meet on July 15, 2026 in Cairo.' }, ['text']
    ), false);
    // The completed verb shares the sentence with the future date.
    assert.equal(hasInvalidGeneratedDate(
      { text: 'The deal was announced in May. The summit concluded on July 15, 2026.' }, ['text']
    ), true);
    // Bare auxiliaries no longer count as completed actions.
    assert.equal(hasInvalidGeneratedDate(
      { text: 'The plan, which was ambitious, is scheduled for July 15, 2026.' }, ['text']
    ), false);
  } finally {
    delete process.env.CONTXT_CURRENT_DATE;
  }
});

test('removes unknown gaps that talk about retrieval instead of the story', () => {
  const brief = validateBrief({
    sources: [{ name: 'AP', url: 'https://apnews.com/article/x-y' }],
    unknown: {
      headline: 'h',
      gaps: [
        { bold: 'Mediator details missing', text: 'Retrieved sources do not specify any new proposal text.', source: '', url: '' },
        { bold: 'Qatari perspective missing', text: 'Geographic coverage notes Qatar, but retrieved source text here contains no direct statement.', source: '', url: '' },
        { bold: 'Disarmament timetable open', text: 'No date has been set for Hamas to begin handing over weapons.', source: '', url: '' }
      ]
    }
  });

  assert.equal(brief.unknown.gaps.length, 1);
  assert.equal(brief.unknown.gaps[0].bold, 'Disarmament timetable open');
});

test('keeps only one claimed position per speaker', () => {
  const position = (bold, attribution) => ({
    bold, text: 't', quote: '', attribution,
    source: 'AP', url: 'https://apnews.com/article/x-y'
  });
  const brief = validateBrief({
    sources: [{ name: 'AP', url: 'https://apnews.com/article/x-y' }],
    claimed: {
      positions: [
        position('Nickolay Mladenov position', 'Nickolay Mladenov, envoy, May 13 2026'),
        position('Nickolay Mladenov warning', 'Nickolay Mladenov, envoy, May 13 2026'),
        position('Hamas position', 'Hamas statement, June 10 2026')
      ]
    }
  });

  assert.equal(brief.claimed.positions.length, 2);
  assert.equal(brief.claimed.positions[1].bold, 'Hamas position');
});
