const { retrieveSources } = require('./retrieval');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 5000; 


async function buildModelRequest(topic, logger) {
  const retrieval = await retrieveSources(topic, logger);
  const retrievalValue = retrieval.value;
  if (retrievalValue.status === 'no_coverage') {
    return retrievalValue;
  }

  const fallbackInstruction = retrievalValue.sufficient
    ? ''
    : '\n\nRetrieval was insufficient. Do not search. Return the best valid JSON brief possible from retrieved sources and mark unverified gaps as unknown.';

  const userContent = `Create a Contxt brief for this topic: "${topic}".\n\n${retrievalValue.packageText}${fallbackInstruction}`;

  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: [
      { type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }
    ],
    output_config: { format: { type: 'json_schema', schema: briefSchema() } },
    messages: [{ role: 'user', content: userContent }]
  };
}


function systemPrompt() {
  return `You are Contxt, a structured news briefing system. Organize the retrieved source material into a structured news brief.

RULES:
- Never issue verdicts or show bias
- Quotes must be 100% verbatim
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
- Every claimed position MUST include a verbatim quote. If no verbatim quote exists in your search results, do not include that position.`;
}

// JSON Schema for structured outputs.
function briefSchema() {
  const str = { type: 'string' };
  const s = (description) => ({ type: 'string', description });
  const obj = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  });
  const arr = (itemProps) => ({ type: 'array', items: obj(itemProps) });

  return obj({
    topic: s('Short plain title'),
    tag: s('Category · Region'),
    confirmed: obj({
      headline: s('What the record shows'),
      facts: arr({ bold: s('Opening bold phrase'), text: s('rest of sentence'), source: str, url: str })
    }),
    claimed: obj({
      headline: s('What each side says'),
      positions: arr({ bold: s('Entity name + position'), text: str, quote: s('verbatim quote'), attribution: s('name, title, date'), source: str, url: str })
    }),
    disputed: obj({
      headline: s('The core fights'),
      fights: arr({ question: s('The disputed question'), side1: str, side1_source: str, side1_url: str, side2: str, side2_source: str, side2_url: str })
    }),
    unknown: obj({
      headline: s('What no one can answer yet'),
      gaps: arr({ bold: str, text: str, source: str, url: str })
    }),
    sources: arr({ flag: str, name: str, url: str })
  });
}

module.exports = { buildModelRequest, defaultSystemPrompt: systemPrompt, briefSchema };
