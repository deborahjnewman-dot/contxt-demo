function ok(value) {
  return { ok: true, value };
}

function err(error) {
  return { ok: false, error };
}

module.exports = { ok, err };
