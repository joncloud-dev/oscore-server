// Shared by the /cmd route handlers through require(). Handlers cannot see
// a hook file's top-level scope, so $app is passed in.
module.exports = {
  // next returns the device's oldest pending command as {i, c, a}, or null.
  next(app, deviceId) {
    const rows = app.findRecordsByFilter(
      "device_commands", "device = {:d} && state = 'pending'", "seq", 1, 0, { d: deviceId });
    if (rows.length === 0) {
      return null;
    }
    const args = rows[0].getString("args");
    return { i: rows[0].getInt("seq"), c: rows[0].getString("op"), a: args ? JSON.parse(args) : null };
  },

  // ack records the device's result for a pending command and reports
  // whether there was one.
  ack(app, deviceId, seq, result) {
    let rec;
    try {
      rec = app.findFirstRecordByFilter(
        "device_commands", "device = {:d} && seq = {:s} && state = 'pending'", { d: deviceId, s: seq });
    } catch (_) {
      return false;
    }
    rec.set("state", result === 0 ? "done" : "failed");
    rec.set("result", result);
    app.save(rec);
    return true;
  },
};
