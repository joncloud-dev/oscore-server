# acme-thermo: a JSON device with a `pb_hooks` codec and command routes

`pb_hooks/acme-thermo.pb.js` registers a Wi-Fi thermometer platform with
`$iot.platform`, a codec, `acme-json`, with `$iot.codec`, and a pull command
channel, `GET /cmd` and `POST /cmd/ack`, with `$iot.coapRoute`. The device posts
JSON to `/t` over OSCORE instead of the compact iot-cbor check-in:

```json
{"ts":1700000000,"fw":"1.4.0","t":2150,"h":40.5,"bat":87,"rssi":-61}
```

The codec returns metrics by name. `profile.json` maps each name to a storage
key, so the dashboards and the public projection read them unchanged.

## Run it

`pb_migrations/1740000000_device_commands.js` creates the `device_commands`
collection the routes read and write; `serve` applies it on first boot.

```sh
cp oscore-server examples/acme-thermo/
cd examples/acme-thermo
./oscore-server superuser upsert admin@example.com 'change-me-please'
PB_OSCORE_KEK=<64 hex chars> ./oscore-server serve
```

Create the profile from `profile.json`, provision a device on the `wifi`
transport and point it at the profile:

```sh
curl -X POST localhost:8090/api/collections/device_profiles/records \
  -H "Authorization: $TOKEN" -H 'content-type: application/json' -d @profile.json
PB_EMAIL=admin@example.com PB_PASSWORD='change-me-please' \
  go run ./cmd/loadgen provision -base http://127.0.0.1:8090 -n 1 -prefix thermo -transport wifi
curl -X PATCH localhost:8090/api/collections/devices/records/$DEVICE \
  -H "Authorization: $TOKEN" -H 'content-type: application/json' -d '{"profile":"'$PROFILE'"}'
```

## Send a reading

```sh
go run ./cmd/loadgen checkin -addr 127.0.0.1:5683 -device thermo-000 \
  -payload-json '{"ts":1700000000,"fw":"1.4.0","t":2150,"h":40.5,"bat":87,"rssi":-61}'
```

```
device thermo-000 sent POST /t (json) payload {"ts":1700000000,"fw":"1.4.0","t":2150,"h":40.5,"bat":87,"rssi":-61}
inner response 2.04 payload ""
```

The telemetry row stores the metrics under the profile's keys and the codec's
`extra` under `x`. The device's `fw_version` becomes `1.4.0`:

```json
{"data":{"10":87,"11":21.5,"12":40.5,"x":{"rssi":-61}},"transport":"wifi","ts":"2023-11-14 22:13:20.000Z"}
```

`{"kind":"keepalive"}` makes the codec return `null`. The device gets 2.04,
`last_seen` advances, and no row is written.

## When the codec says no

A body the codec rejects answers 4.00, and the server logs why:

```
deviceapi: telemetry from device 0i7cdtykbg48va9 rejected: codec "acme-json": SyntaxError: Unexpected end of JSON input (EOF) at iotcore/internal/platform/jsbindings.uplinkInput.func2 (native)
```

The same happens for a metric name the profile does not declare, a transport
the platform does not have, or an unknown field in the returned object.

A codec that never returns (`while (true) {}`) is interrupted after 250ms. The
device gets 5.03 with Max-Age 2, the runtime goes back to the pool, and other
devices are served while it spins:

```
inner response 5.03 payload ""
outer Max-Age 2
deviceapi: telemetry from device t42utxdbyln6kdj deferred: ext: unavailable: codec "acme-json-spin": jsbindings: JS call exceeded its budget (250ms)
```

## Send it a command

The operator queues a row in `device_commands`. `seq` orders the device's
commands, and `args` is any JSON:

```sh
curl -X POST localhost:8090/api/collections/device_commands/records \
  -H "Authorization: $TOKEN" -H 'content-type: application/json' \
  -d '{"device":"'$DEVICE'","seq":1,"op":"setpoint","args":{"t":2150,"hyst":50},"state":"pending"}'
```

After each check-in the device asks for its oldest pending command. The route
answers CBOR `{"i": seq, "c": op, "a": args}`, or an empty 2.05 when nothing is
pending:

```sh
go run ./cmd/loadgen request -addr 127.0.0.1:5683 -device thermo-000 -method GET -path /cmd
```

```
device thermo-000 sent OSCORE GET /cmd payload 
inner response 2.05 format cbor payload (30 bytes) a3 61 61 a2 64 68 79 73 74 18 32 61 74 19 08 66 61 63 68 73 65 74 70 6f 69 6e 74 61 69 01
payload as CBOR: {"a":{"hyst":50,"t":2150},"c":"setpoint","i":1}
```

The device acks with CBOR `{"i": seq, "r": result}`, where result 0 is
success. The row becomes `done` (or `failed`) and the next GET /cmd moves on:

```sh
go run ./cmd/loadgen request -addr 127.0.0.1:5683 -device thermo-000 \
  -method POST -path /cmd/ack -cf cbor -payload-hex a2616901617200
```

```
device thermo-000 sent OSCORE POST /cmd/ack payload a2 61 69 01 61 72 00
inner response 2.04 format none payload (0 bytes) 
```

An ack for a seq that is not pending answers 4.04, a body that is not that
CBOR map 4.00, and DELETE /cmd 4.05. A NON ack is applied with no response.

`GET /cmd` sets `maxBody: 128`, so a command whose CBOR would be larger answers
5.00 instead of a truncated body. The server logs it and records a
`device.route_oversize` event:

```
deviceapi: route GET /cmd from device gnolw8x5v7cms1m failed: response body is 141 bytes, over maxBody 128 (no Block2)
```

```json
{"type":"device.route_oversize","device":"gnolw8x5v7cms1m","severity":"warning","data":{"max_body":128,"method":"GET","path":"/cmd","size":141}}
```

A route that never returns (`while (true) {}`) is interrupted after 1s and
answers 5.03 with Max-Age 2. Check-ins on `/t` are served meanwhile, because
route calls can hold at most half of the JS runtimes.
