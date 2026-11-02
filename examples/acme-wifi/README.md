# acme-wifi: a hardware platform from `pb_hooks`

`pb_hooks/acme-wifi.pb.js` registers a non-cellular board (Wi-Fi or Ethernet,
no GNSS assistance) against the shipped binary with `$iot.platform`. It has its
own transport codes, reset reasons, fault labels and firmware image types.

## Run it

Put the binary and `pb_hooks/` side by side. PocketBase resolves `pb_data` and
`pb_hooks` next to the executable unless `--dir` or `PB_HOOKS_DIR` says
otherwise.

```sh
cp oscore-server examples/acme-wifi/
cd examples/acme-wifi
./oscore-server superuser upsert admin@example.com 'change-me-please'
PB_OSCORE_KEK=<64 hex chars> ./oscore-server serve
```

Boot widens the select fields with the platform's values:

```
extensions: widened firmware_images.type: [app spiffs]
extensions: widened device_resets.reason: [panic ota deep_sleep]
```

`GET /api/ui/config` lists it under `extensions.platforms` as
`{"name":"acme-wifi","source":"js"}`, with its decoder tables under
`platforms["acme-wifi"]`.

## Put devices on it

Create a profile that names the platform, then point devices at it:

```sh
curl -X POST localhost:8090/api/collections/device_profiles/records \
  -H "Authorization: $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"acme-sensor","platform":"acme-wifi"}'
```

A device on that profile that checks in with transport code 2 is stored with
`transport: "ethernet"`. The same code on `nordic-nrf91` means `ntn`.

## When the spec is wrong

A bad spec stops every command (`serve`, `migrate`, `provision`) with exit
status 1 and names the file and the field:

```
pb_hooks: failed to execute acme-lte.pb.js:
 - GoError: $iot.platform: unknown field "imageType" (allowed: name, transports, resetReasons, hwCauseBits, faultTypes, imageTypes, deviceInfoFields, codeAddrClearMask, agnss)
```

Deleting the hook file does not stop the server. Profiles that name
`acme-wifi` are logged as quarantined at boot, and their devices get 5.03 until
the platform is registered again.
