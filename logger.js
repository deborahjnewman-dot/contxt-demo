function createLogger(bindings = {}) {
  const debugEnabled = process.env.LOG_LEVEL === 'debug';

  function write(level, message, fields = {}) {
    if (level === 'debug' && !debugEnabled) return;

    // message comes right after level/time so each line leads with what happened,
    // followed by the contextual fields (topic, counts, errors).
    const entry = {
      level,
      time: new Date().toISOString(),
      message,
      ...bindings,
      ...sanitize(fields)
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }

  return {
    child(childBindings) {
      return createLogger({ ...bindings, ...childBindings });
    },
    info(fields, message) {
      write('info', message, fields);
    },
    debug(fields, message) {
      write('debug', message, fields);
    },
    warn(fields, message) {
      write('warn', message, fields);
    },
    error(fields, message) {
      write('error', message, fields);
    }
  };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'headers') {
      sanitized.response_headers = summarizeHeaders(nested);
      continue;
    }
    if (key.toLowerCase() === 'set-cookie') continue;
    sanitized[key] = sanitize(nested);
  }
  return sanitized;
}

function summarizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const summary = {};
  for (const key of ['server', 'content-type', 'content-length', 'retry-after', 'x-cache']) {
    const value = headers[key] || headers[key.toLowerCase()];
    if (value) summary[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return summary;
}

module.exports = { createLogger };
