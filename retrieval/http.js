const http = require('http');
const https = require('https');
const { URL } = require('url');
const { ok, err } = require('./result');


const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function requestText(url, options = {}) {
  const timeoutMs = options.timeoutMs || 3500;

  return new Promise((resolve) => {
    let settled = false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve(err({ code: 'invalid_url', message: error.message, url }));
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      req.destroy(new Error('timeout'));
    }, timeoutMs);
    const req = transport.request(parsed, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': options.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...options.headers
      },
      timeout: timeoutMs
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, parsed).toString();
        requestText(nextUrl, options).then(settle);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > (options.maxBytes || 3000000)) req.destroy(new Error('response_too_large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          settle(err({ code: 'http_status', statusCode: res.statusCode, headers: res.headers, url }));
          return;
        }
        settle(ok({ body, finalUrl: url, headers: res.headers }));
      });
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      settle(err({ code: error.message === 'timeout' ? 'timeout' : 'request_failed', message: error.message, url }));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestJson(url, options = {}) {
  return requestText(url, { ...options, accept: 'application/json' }).then((result) => {
    if (!result.ok) return result;
    try {
      return ok({ ...result.value, json: JSON.parse(result.value.body) });
    } catch (error) {
      return err({ code: 'invalid_json', message: error.message, url });
    }
  });
}

module.exports = { requestJson, requestText };
