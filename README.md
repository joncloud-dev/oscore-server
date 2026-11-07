# oscore-server

A single binary that connects constrained cellular devices (Nordic nRF91,
LTE-M / NB-IoT, terrestrial and NTN) to a backend over **OSCORE (RFC 8613)**
end-to-end security on CoAP/UDP. It is built on **PocketBase**: SQLite, admin UI,
REST, JS hooks and file storage, all in one process.

This repository holds the **released binaries and Docker image** plus the
public extension SDK. You build products on top of it **without the server's
source and without rebuilding it**, using device profiles, `pb_hooks` JS,
`pb_migrations` and a static site.

- **Releases:** [Releases page](https://github.com/joncloud-dev/oscore-server/releases):
  static `tar.gz` per OS/arch (`linux`/`darwin` × `amd64`/`arm64`) + `checksums.txt`
- **Image:** `ghcr.io/joncloud-dev/oscore-server:<version>` (`linux/amd64`, `linux/arm64`)
- **Example product:** [joncloud-dev/water-temp](https://github.com/joncloud-dev/water-temp),
  a water-temperature monitor built entirely on the extension layer

## Quick start (Docker)

```sh
export PB_OSCORE_KEK=$(openssl rand -hex 32)   # keep it: rotating it orphans every device key
docker run -d --name oscore-server \
  -p 8090:8090 -p 5683:5683/udp \
  -e PB_OSCORE_KEK \
  -v oscore-data:/pb_data \
  ghcr.io/joncloud-dev/oscore-server:<version>

docker exec oscore-server \
  oscore-server superuser upsert you@example.com 'a-strong-password' --dir=/pb_data
```

The admin UI is at `http://localhost:8090/_/` and devices talk OSCORE to UDP
`5683`. Mount your own `pb_hooks`, `pb_migrations` and `pb_public` directories at
`/pb_hooks`, `/pb_migrations` and `/pb_public` to add a product.

## Quick start (binary)

```sh
tar xzf oscore-server_<version>_linux_amd64.tar.gz
sha256sum --check --ignore-missing checksums.txt
export PB_OSCORE_KEK=$(openssl rand -hex 32)
./oscore-server superuser upsert you@example.com 'a-strong-password' --dir=$PWD/pb_data
PB_HOOKS_DIR=./pb_hooks PB_JS_MIGRATIONS_DIR=./pb_migrations PB_PUBLIC_DIR=./pb_public \
  ./oscore-server serve --http=0.0.0.0:8090 --dir=$PWD/pb_data
```

## Provision a device

```sh
TOKEN=$(curl -s -X POST http://localhost:8090/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"you@example.com","password":"a-strong-password"}' | jq -r .token)

curl -s -X POST http://localhost:8090/api/provision \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"hw_id":"my-device-01","transport":"tn"}'
# -> {"hw_id":..,"sender_id":"01","recipient_id":"..","master_secret":"..","master_salt":"..",..}
```

Load that material once on the device (for the nRF91 reference firmware:
`oscore provision <master_secret> <master_salt> <recipient_id> <sender_id>` on
the shell), then reboot.

## What's here

| Path | What |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | Environment variables, volumes, ports, and Coolify / Fly / bare-VM notes |
| [`sdk/types/iot.d.ts`](sdk/types/iot.d.ts) | Type declarations for the `$iot` global in `pb_hooks` / `pb_migrations` |
| [`sdk/schemas/`](sdk/schemas/) | JSON Schema for `device_profiles` records |
| [`sdk/protocol/`](sdk/protocol/) | The device wire contract (resources, CBOR keys, response codes) + CDDL |
| [`examples/`](examples/) | Small extension examples (custom codec, CoAP route, platform) |
| [`docs/`](docs/) | Extension-facing docs and the A-GNSS body schema |

## Licensing

- The **server binary and Docker image** are free to use for any purpose, on
  any number of devices, under the [Binary License](LICENSE-BINARY.txt). It is
  closed source: you may not modify or rebrand the binary, or resell it as a
  general IoT platform service. Source access, warranty and support are
  available commercially from Equital AS.
- **Everything in this repository** (SDK, examples, docs) is MIT, see
  [`LICENSE`](LICENSE). Write and share hooks, profiles and products freely.
- Third-party components bundled in the binary are listed in
  [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).
