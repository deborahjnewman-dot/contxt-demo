const { retrieveSources } = require('./retrieval');
const { currentDateString } = require('./current-date');

const MAX_TOKENS = 4096;


async function buildModelRequest(topic, logger) {
  const retrieval = await retrieveSources(topic, logger);
  const retrievalValue = retrieval.value;
  if (retrievalValue.status === 'no_coverage') {
    return retrievalValue;
  }

  const fallbackInstruction = retrievalValue.sufficient
    ? ''
    : '\n\nSource material is thin. Do not search. Return the best valid JSON brief possible from the sources and phrase what remains unverified as open questions about the story in the unknown section.';

  const userContent = `Create a Contxt brief for this topic: "${topic}".\n\n${retrievalValue.packageText}${fallbackInstruction}`;

  return {
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }
    ],
    output_config: { format: { type: 'json_schema', schema: briefSchema() } },
    messages: [{ role: 'user', content: userContent }],
    // Carried alongside the request (ignored by the LLM client) so the server
    // can log retrieval stats and validate quotes against the source text.
    sourceCount: retrievalValue.sourceCount,
    quoteCount: retrievalValue.quoteCount,
    retrievedSources: retrievalValue.sources
  };
}


function systemPrompt() {
  return `You are Contxt, a structured news briefing system. Organize the retrieved source material into a structured news brief.

RULES:
- Today is ${currentDateString()}. Never describe future dates as already happened.
- Always write the final brief in English, even when source material is in another language.
- Never issue verdicts or show bias
- Quotes must be 100% verbatim, exactly as they appear in the retrieved source text. Never invent or paraphrase a quote.
- If a source quote is not English, do not include it as a quote; summarize the position in English without a quote.
- Bold leads each sentence (use the "bold" field for the opening phrase)
- No em-dashes, no colons after names
- Keep facts tight and clear
- Max 3 items per array section
- Each text field max 25 words
- Use real, verifiable sources. Prioritize AP, Reuters, BBC, Al Jazeera, The Guardian, and official government and UN sources. Avoid blogs, opinion sites, and unverified sources.
- Sources array must contain between 4 and 6 items. Never fewer than 4
- Only include facts, claims, and disputes that appear explicitly in the retrieved source text. Do not use background knowledge. If a section cannot be populated from retrieved sources, leave it empty.
- Both sides of every disputed fight must cite different entities and different source URLs. If both sides would cite the same outlet, do not include the fight. If no genuine factual dispute exists in the sources, leave the Disputed section empty.
- Every quote must be at least 10 words. A quote must be exact words spoken or written by the named person or institution. Do not use a journalist's description of a statement as a quote. If no qualifying quote exists, do not include the position.
- A quote must directly support the specific claim it is attached to. If no qualifying quote exists for a claim, leave the quote field empty.
- Each claimed position must come from a different person or institution. Never include two positions from the same speaker.
- Include specific dates and key statistics where they appear in the source text. Every specific date must include a year. Do not describe a trend without an available number or an event without an available date.
- Prefer primary sources first, then AP/Reuters, then independent news outlets.
- Lead with the most recent developments. Older material is background, not the headline.
- The unknown section lists open questions about the story itself (what is not yet known, decided, or confirmed). Write them as news. Never mention retrieval, source availability, or what sources do or do not contain.
- If an important national perspective is missing for an international topic, phrase it in the unknown section as an open question about that actor's position, not as a comment about coverage.`;
}

// JSON Schema for structured outputs. maxItems enforces the per-section caps
// at the decoder level instead of relying on the prompt rules alone.
function briefSchema() {
  const str = { type: 'string' };
  const s = (description) => ({ type: 'string', description });
  const obj = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  });
  const arr = (itemProps, maxItems) => ({ type: 'array', maxItems, items: obj(itemProps) });

  return obj({
    topic: s('Short plain title'),
    tag: s('Category · Region'),
    confirmed: obj({
      headline: s('What the record shows'),
      facts: arr({ bold: s('Opening bold phrase'), text: s('rest of sentence'), source: str, url: str }, 3)
    }),
    claimed: obj({
      headline: s('What each side says'),
      positions: arr({ bold: s('Entity name + position'), text: str, quote: s('verbatim quote'), attribution: s('name, title, date'), source: str, url: str }, 3)
    }),
    disputed: obj({
      headline: s('The core fights'),
      fights: arr({ question: s('The disputed question'), side1: str, side1_source: str, side1_url: str, side2: str, side2_source: str, side2_url: str }, 3)
    }),
    unknown: obj({
      headline: s('What no one can answer yet'),
      gaps: arr({ bold: str, text: str, source: str, url: str }, 3)
    }),
    sources: arr({ flag: str, name: str, url: str }, 6)
  });
}

module.exports = { buildModelRequest, defaultSystemPrompt: systemPrompt, briefSchema };
