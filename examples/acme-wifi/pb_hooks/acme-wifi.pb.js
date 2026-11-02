/// <reference path="../../../sdk/types/iot.d.ts" />

// A non-cellular product: an ESP32-class board on Wi-Fi or Ethernet, with no
// GNSS assistance. Its enums reach the select fields at the next boot.
$iot.platform({
  name: "acme-wifi",
  transports: { 1: "wifi", 2: "ethernet" },
  resetReasons: ["power_on", "brownout", "watchdog", "panic", "ota", "deep_sleep"],
  faultTypes: ["load_prohibited", "store_prohibited", "illegal_instruction"],
  imageTypes: { app: 1, spiffs: 2 },
  deviceInfoFields: { bd: "board" },
});
