// Single source of "today" for both prompting and output validation, so the
// date the model is told and the date briefs are validated against can never
// diverge. CONTXT_CURRENT_DATE (YYYY-MM-DD) pins the clock for tests/replays.
function currentDateString() {
  const configured = process.env.CONTXT_CURRENT_DATE;
  if (configured && /^\d{4}-\d{2}-\d{2}$/.test(configured)) return configured;
  return new Date().toISOString().slice(0, 10);
}

function currentUtcDay() {
  const [year, month, day] = currentDateString().split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

module.exports = { currentDateString, currentUtcDay };
