const { createLlmClient } = require('../../llm');
const { buildModelRequest } = require('../../brief-request');
const { createLogger } = require('../../logger');
const { prepareBriefOutput } = require('../../brief-output');

exports.handler = async function(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  const LLM_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!LLM_API_KEY) {
    return { 
      statusCode: 500, 
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'API key not configured' }) 
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const logger = createLogger({ service: 'contxt-netlify' });
  const topic = String(body.topic || '').trim();
  if (!topic) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'topic is required' })
    };
  }

  try {
    const requestBody = await buildModelRequest(topic, logger);
    if (requestBody.status === 'no_coverage') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(requestBody)
      };
    }

    const fullText = await createLlmClient(LLM_API_KEY).collectMessage(requestBody);
    const prepared = prepareBriefOutput(fullText);
    if (!prepared.ok) {
      throw new Error(prepared.error);
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: prepared.text
    };
  } catch (err) {
    logger.error({ topic, error: err.message }, 'brief function failed');
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
