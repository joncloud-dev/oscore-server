/// <reference path="../../../pb_data/types.d.ts" />

// Commands queued for acme-thermo devices, served by the /cmd routes in
// pb_hooks/acme-thermo.pb.js.
migrate(
  (app) => {
    const devices = app.findCollectionByNameOrId("devices");
    app.save(new Collection({
      type: "base",
      name: "device_commands",
      fields: [
        { name: "device", type: "relation", required: true, collectionId: devices.id, maxSelect: 1, cascadeDelete: true },
        { name: "seq", type: "number", required: true, onlyInt: true, min: 1 },
        { name: "op", type: "text", required: true, max: 32 },
        { name: "args", type: "json", maxSize: 512 },
        { name: "state", type: "select", required: true, maxSelect: 1, values: ["pending", "done", "failed"] },
        { name: "result", type: "number", onlyInt: true },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_device_commands_seq ON device_commands (device, seq)"],
    }));
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("device_commands"));
  }
);
