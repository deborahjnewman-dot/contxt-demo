const { fetchTargetedSources } = require('./targeted');
const { formatForModel } = require('./format');
const { ok } = require('./result');

const TARGETED_BUDGET_MS = Number(process.env.TARGETED_BUDGET_MS) || 12000;
const MIN_VALID_SOURCES = Number(process.env.MIN_VALID_SOURCES) || 3;
// News briefs should be built from this week's coverage; the window only widens
// to the past month when the fresh pass finds too little.
const PRIMARY_FRESHNESS = process.env.BRAVE_FRESHNESS || 'pw';
const WIDENED_FRESHNESS = 'pm';

function withBudget(promise, budgetMs, label, logger) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ source: label, budget_ms: budgetMs }, `retrieval: ${label} hit the ${budgetMs}ms time budget — continuing without it`);
      resolve(ok([]));
    }, budgetMs);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => {
        clearTimeout(timer);
        logger.warn({ source: label, error: error.message }, `retrieval: ${label} threw an error — continuing without it`);
        resolve(ok([]));
      }
    );
  });
}

async function retrieveSources(topic, logger) {
  const startedAt = Date.now();
  const retrievalLogger = logger.child({ unit: 'retrieval', topic });
  retrievalLogger.info({}, 'retrieval: started');

  const targetedResult = await withBudget(
    fetchTargetedSources(topic, retrievalLogger.child({ source: 'targeted' }), PRIMARY_FRESHNESS),
    TARGETED_BUDGET_MS, 'targeted', retrievalLogger
  );

  const resultSets = [
    targetedResult.ok ? targetedResult.value : []
  ];

  if (resultSets[0].length < MIN_VALID_SOURCES && PRIMARY_FRESHNESS !== WIDENED_FRESHNESS) {
    retrievalLogger.info({ fresh_sources: resultSets[0].length, widened_to: WIDENED_FRESHNESS }, 'retrieval: too few fresh sources — widening search window');
    const widenedResult = await withBudget(
      fetchTargetedSources(topic, retrievalLogger.child({ source: 'targeted-widened' }), WIDENED_FRESHNESS),
      TARGETED_BUDGET_MS, 'targeted-widened', retrievalLogger
    );
    resultSets.push(widenedResult.ok ? widenedResult.value : []);
  }

  const formatted = formatForModel(topic, resultSets);
  const elapsedMs = Date.now() - startedAt;

  retrievalLogger.info({
    elapsed_ms: elapsedMs,
    sources_kept: formatted.value.sourceCount,
    quotes: formatted.value.quoteCount,
    international: formatted.value.internationalFound
  }, 'retrieval: completed');

  if (formatted.value.sourceCount === 0) {
    retrievalLogger.warn({
      sources_kept: formatted.value.sourceCount,
      elapsed_ms: elapsedMs
    }, 'retrieval: NO COVERAGE — zero valid sources, skipping model');

    return ok({
      status: 'no_coverage',
      topic,
      reason: 'no_reports',
      message: 'No reports on this topic.',
      sourceCount: formatted.value.sourceCount,
      elapsedMs
    });
  }

  if (formatted.value.sourceCount < MIN_VALID_SOURCES) {
    retrievalLogger.warn({
      sources_kept: formatted.value.sourceCount,
      min_required: MIN_VALID_SOURCES,
      elapsed_ms: elapsedMs
    }, 'retrieval: NO COVERAGE — too few valid sources, skipping model');

    return ok({
      status: 'no_coverage',
      topic,
      reason: 'too_few_sources',
      message: 'Too few credible sources found to generate a brief.',
      sourceCount: formatted.value.sourceCount,
      elapsedMs
    });
  }

  return ok({
    ...formatted.value,
    elapsedMs,
    sufficient: formatted.value.sourceCount >= 3 && formatted.value.quoteCount >= 1
  });
}

module.exports = { retrieveSources };
