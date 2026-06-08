const { fetchTargetedSources } = require('./targeted');
const { fetchGdeltSources } = require('./gdelt');
const { formatForModel } = require('./format');
const { ok } = require('./result');

const TARGETED_BUDGET_MS = Number(process.env.TARGETED_BUDGET_MS) || 4500;
const GDELT_BUDGET_MS = Number(process.env.GDELT_BUDGET_MS) || 3000;

function withBudget(promise, budgetMs, label, logger) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ source: label, budget_ms: budgetMs }, 'source exceeded budget; continuing without it');
      resolve(ok([]));
    }, budgetMs);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => {
        clearTimeout(timer);
        logger.warn({ source: label, error: error.message }, 'source threw; continuing without it');
        resolve(ok([]));
      }
    );
  });
}

async function retrieveSources(topic, logger) {
  const startedAt = Date.now();
  const retrievalLogger = logger.child({ unit: 'retrieval', topic });

  const [gdeltResult, targetedResult] = await Promise.all([
    withBudget(
      fetchGdeltSources(topic, retrievalLogger.child({ source: 'gdelt' })),
      GDELT_BUDGET_MS, 'gdelt', retrievalLogger
    ),
    withBudget(
      fetchTargetedSources(topic, retrievalLogger.child({ source: 'targeted' })),
      TARGETED_BUDGET_MS, 'targeted', retrievalLogger
    )
  ]);

  const resultSets = [
    gdeltResult.ok ? gdeltResult.value : [],
    targetedResult.ok ? targetedResult.value : []
  ];
  const formatted = formatForModel(topic, resultSets);
  const elapsedMs = Date.now() - startedAt;

  retrievalLogger.info({
    elapsed_ms: elapsedMs,
    source_count: formatted.value.sourceCount,
    quote_count: formatted.value.quoteCount,
    international_found: formatted.value.internationalFound
  }, 'retrieval completed');

  return ok({
    ...formatted.value,
    elapsedMs,
    sufficient: formatted.value.sourceCount >= 3 && formatted.value.quoteCount >= 1
  });
}

module.exports = { retrieveSources };
