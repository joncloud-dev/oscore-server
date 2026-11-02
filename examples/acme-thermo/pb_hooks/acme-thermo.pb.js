/// <reference path="../../../sdk/types/iot.d.ts" />

// A Wi-Fi thermometer that reports JSON over OSCORE:
//   {"ts":1700000000,"fw":"1.4.0","t":2150,"h":40.5,"bat":87,"rssi":-61}
// or {"kind":"keepalive"} when nothing changed.
$iot.platform({
  name: "acme-thermo",
  transports: { 1: "wifi" },
  resetReasons: ["power_on", "brownout", "watchdog", "panic"],
});

// Devices whose profile sets codec "acme-json" decode here. The handler runs
// in the $iot runtime pool, so it sees only its argument and the globals, not
// this file's top-level scope.
$iot.codec("acme-json", function (input) {
  const m = input.json();
  if (m.kind === "keepalive") {
    return null;
  }
  return {
    time: m.ts,
    fwVersion: m.fw,
    transport: "wifi",
    metrics: { temperature: m.t / 100, humidity: m.h, battery: m.bat },
    extra: { rssi: m.rssi },
  };
});

// A pull-model command channel. The operator queues rows in device_commands
// (pb_migrations/1740000000_device_commands.js); the device polls GET /cmd
// after each check-in and acks with POST /cmd/ack. A command is resent until
// it is acked. The response body is CBOR and must fit in 128 bytes.
$iot.coapRoute("GET", "/cmd", function (req) {
  const cmd = require(`${__hooks}/lib/commands.js`).next($app, req.device.id);
  if (!cmd) {
    return { status: "content" };
  }
  return { status: "content", body: cmd };
}, { maxBody: 128 });

// The ack body is CBOR {"i": seq, "r": result}; result 0 is success.
$iot.coapRoute("POST", "/cmd/ack", function (req) {
  let ack;
  try {
    ack = req.cbor();
  } catch (_) {
    return { status: "badRequest" };
  }
  if (typeof ack.i !== "number" || typeof ack.r !== "number") {
    return { status: "badRequest" };
  }
  const acked = require(`${__hooks}/lib/commands.js`).ack($app, req.device.id, ack.i, ack.r);
  return { status: acked ? "changed" : "notFound" };
});
