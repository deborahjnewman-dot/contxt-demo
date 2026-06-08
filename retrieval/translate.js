const { requestJson } = require('./http');
const { ok, err } = require('./result');

function translateToEnglish(source, logger) {
  if (source.language === 'en') return Promise.resolve(ok(source));
  if (!process.env.DEEPL_API_KEY) return Promise.resolve(ok(source));

  const body = new URLSearchParams({
    text: source.extracted_text,
    target_lang: 'EN'
  }).toString();

  return requestJson(process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    timeoutMs: 2500,
    headers: {
      'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  }).then((result) => {
    if (!result.ok) {
      logger.warn({ source_name: source.source_name, error: result.error }, 'translation failed');
      return ok(source);
    }

    const translation = result.value.json.translations?.[0];
    const translatedText = translation?.text;
    if (!translatedText) return err({ code: 'translation_empty' });

    // DeepL reports the source language it auto-detected; record it so the
    // Result Schema / model output shows the real origin language.
    const detected = (translation.detected_source_language || '').toLowerCase();

    return ok({
      ...source,
      extracted_text: translatedText,
      language: detected || source.language,
      translated: true
    });
  });
}

module.exports = { translateToEnglish };
