function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function createRateLimiter(minIntervalMs) {
  let gate = Promise.resolve();
  let lastStartedAt = 0;

  function schedule(fn) {
    const run = gate.then(async () => {
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStartedAt));
      if (waitMs > 0) await delay(waitMs);
      lastStartedAt = Date.now();
      return fn();
    });

    // Keep the gate alive even if a task rejects, so one failure never stalls the queue.
    gate = run.then(() => {}, () => {});
    return run;
  }

  return { schedule };
}

module.exports = { createRateLimiter, delay };
