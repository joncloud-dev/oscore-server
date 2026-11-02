# Deploying the OSCORE platform server

The server is a single static Go binary bundling PocketBase (HTTP admin UI +
REST on `:8090`) and the OSCORE-protected CoAP server (UDP on `:5683`).

## What it needs

| Requirement        | Detail                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `PB_OSCORE_KEK`    | **Required.** 32-byte hex AES-256 key-encryption key. `openssl rand -hex 32`. Without it, serve aborts. |
| `PB_RETENTION_DAYS`| Optional. Telemetry/event retention window (default `90`, `0` disables). |
| `GOOGLE_GEOLOCATION_API_KEY` | Optional. Enables cloud-side cell/Wi-Fi → lat/lon resolution via the Google Geolocation API. Unset ⇒ scans are stored but not resolved. See [Location resolution](#location-resolution-cellwi-fi). |
| `OSCORE_COAP_ADDR` | UDP listen address (default `:5683`). Fly overrides this — see below.   |
| Volume at `/pb_data` | **Required & durable.** SQLite + OSCORE replay/SSN state. Losing it breaks replay protection; back it up. |
| Port `8090/tcp`    | PocketBase admin UI + REST.                                            |
| Port `5683/udp`    | OSCORE CoAP. This is the part each platform handles differently.       |

> **Keep `PB_OSCORE_KEK` stable.** Rotating it makes every stored OSCORE master
> secret undecryptable. Treat it as a long-lived secret, not a per-deploy value.

## Install from a release

Each `v*` tag publishes two artifacts. You do not need the source for either.

- A multi-arch container image (`linux/amd64`, `linux/arm64`):
  `ghcr.io/joncloud-dev/oscore-server:<version>`. Non-prerelease tags also move
  `latest`.
- A `tar.gz` archive per OS and architecture, with `checksums.txt`, on the
  public distribution repo's releases:
  <https://github.com/joncloud-dev/oscore-server/releases>. It holds the static binary, this file, `README.md`, the
  licenses, the extension SDK (`sdk/`) and `examples/water-temp/`.

Container:

```sh
export PB_OSCORE_KEK=$(openssl rand -hex 32)   # save this somewhere safe
docker run -d --name oscore-server \
  -p 8090:8090 -p 5683:5683/udp \
  -e PB_OSCORE_KEK \
  -v oscore-data:/pb_data \
  ghcr.io/joncloud-dev/oscore-server:<version>
docker exec oscore-server \
  oscore-server superuser upsert you@example.com 'a-strong-password' --dir=/pb_data
```

Mount your extension directories at `/pb_hooks`, `/pb_migrations` and
`/pb_public` to add JS hooks, collections and a public site.

Archive (Linux amd64 shown):

```sh
tar xzf oscore-server_<version>_linux_amd64.tar.gz
sha256sum --check --ignore-missing checksums.txt
export PB_OSCORE_KEK=$(openssl rand -hex 32)
./oscore-server superuser upsert you@example.com 'a-strong-password' --dir=$PWD/pb_data
./oscore-server serve --http=0.0.0.0:8090 --dir=$PWD/pb_data
```

Always pass `--dir`. Without it the data directory is resolved next to the
binary. Point `PB_HOOKS_DIR`, `PB_JS_MIGRATIONS_DIR` and `PB_PUBLIC_DIR` at your
extension directories; `examples/water-temp/README.md` shows a full product,
and <https://github.com/joncloud-dev/water-temp> is the same product as a
standalone repo that runs the released image with `docker compose up`.

The sections below cover building the image from source and platform-specific
setup.

## Container user & volume permissions

The server process runs as the **unprivileged `app` user** (uid 10001), not root.
But a mounted volume (Coolify persistent storage, a Fly volume, a bind mount)
arrives **root-owned**, which would hide the image's build-time ownership and
leave `app` unable to create the SQLite database — the symptom is a restart loop
logging `unable to open database file (14)` (SQLite `SQLITE_CANTOPEN`).

To handle this regardless of how the host mounts the volume, the container's
`entrypoint.sh` starts as root, `chown`s `/pb_data` to `app`, then drops to `app`
via `su-exec` before running the server. So:

- Only the brief entrypoint setup runs as root; the server itself runs as `app`.
- No host-side volume permission tweaking is required — it self-corrects on start.
- Commands you run in the platform's container shell (e.g. `provision`) execute
  as root and can write `/pb_data` freely.

If you replace the entrypoint or set an explicit non-root container user that
*isn't* root (some platforms pin a UID), the entrypoint can't `chown`, so you
must ensure the mounted volume is writable by that UID yourself.

## Local / self-hosted (Docker Compose)

```sh
cd go
export PB_OSCORE_KEK=$(openssl rand -hex 32)   # save this somewhere safe
docker compose up --build -d
```

Admin UI: http://localhost:8090/_/ — create the first superuser on first visit,
or non-interactively:

```sh
docker compose exec oscore-server \
  oscore-server superuser upsert you@example.com 'a-strong-password' --dir=/pb_data
```

Provision devices (CSV copied into the container, then imported):

```sh
docker compose cp ./devices.csv oscore-server:/pb_data/devices.csv
docker compose exec oscore-server \
  oscore-server provision --csv /pb_data/devices.csv --dir=/pb_data
```

See [Provisioning devices](#provisioning-devices) for the CSV format.

## Coolify

Two routes: let Coolify build from your Git repo, or deploy a prebuilt image.
Pick one. Without the source, use Option B with the released image
`ghcr.io/joncloud-dev/oscore-server:<version>` and skip its build and push steps.

### Option A — build from Git

1. New Resource → from your Git repo. Set **Base Directory** to `/go` so the
   build context and `Dockerfile` resolve.
2. **Environment Variables**: add `PB_OSCORE_KEK` (mark as secret/build-time not
   needed — runtime only) and optionally `PB_RETENTION_DAYS`.
3. **Persistent Storage**: add a volume mounted at `/pb_data`. Do this *before*
   the first deploy so no state is written to the ephemeral layer.
4. **Ports**:
   - HTTP `8090` is proxied by Coolify's Traefik — assign your domain; TLS is
     automatic.
   - UDP `5683` is **not** handled by Traefik (HTTP-only). Add a raw port
     mapping `5683:5683/udp` in the resource's port settings so devices can
     reach the CoAP server directly on the host IP. Open `5683/udp` in any
     firewall / security group.

The `Dockerfile` `HEALTHCHECK` hits `/api/health`, which Coolify uses for
rolling-deploy health.

### Option B — build locally, push to Docker Hub, deploy the image

Your Mac (Apple Silicon) and the Coolify host are **both ARM64**, so a plain
local build already produces a `linux/arm64` image the server can run — no
cross-compilation needed. The `--platform` flag below just makes that explicit
(and guards against a future Docker default change).

> If you ever move to an amd64 host, swap to a multi-arch push:
> `docker buildx build --platform linux/amd64,linux/arm64 --push -t ... .`
> A single-arch image built here will not start on a host of the other arch.

1. **Build and tag** (from `go/`), using a real version tag, not just `latest`,
   so Coolify redeploys pull a changed digest:
   ```sh
   cd go
   TAG=$(git rev-parse --short HEAD)
   docker build --platform linux/arm64 \
     --build-arg VERSION=$TAG \
     -t YOURUSER/oscore-server:$TAG \
     -t YOURUSER/oscore-server:latest .
   ```
2. **Push** (after `docker login`):
   ```sh
   docker login
   docker push YOURUSER/oscore-server:$TAG
   docker push YOURUSER/oscore-server:latest
   ```
3. In Coolify: **New Resource → Docker Image** (not Git). Set the image to
   `YOURUSER/oscore-server:<TAG>`. For a private repo, add a **Docker Registry**
   credential in Coolify first and select it.
4. Configure exactly as in Option A from step 2 onward — same **Environment
   Variables** (`PB_OSCORE_KEK`, optional `PB_RETENTION_DAYS`), same
   **Persistent Storage** volume at `/pb_data`, and the same **Ports** (HTTP
   `8090` via the proxy + raw `5683:5683/udp` mapping). The image already
   `EXPOSE`s both and ships the `/api/health` healthcheck.
5. To ship an update: rebuild with a new `$TAG`, push, then point the Coolify
   resource at the new tag and redeploy. The `/pb_data` volume (DB + OSCORE
   replay/SSN state) persists across image swaps.

> Pinning a specific `$TAG` rather than `latest` makes redeploys deterministic
> and lets you roll back by re-selecting the previous tag.

### Adding devices on Coolify

Devices can't be added through the admin UI: the OSCORE master secret must be
KEK-encrypted at rest, which only the `provision` command does. So provisioning
is a one-off command run *inside the running container*, against the same
`/pb_data` volume and the same `PB_OSCORE_KEK` the server uses (an exec'd command
inherits the container's env, so the KEK is already present).

1. In the Coolify resource, open **Terminal** (the web shell into the container).
2. Write the CSV into the persistent volume — paste a heredoc:
   ```sh
   cat > /pb_data/devices.csv <<'EOF'
   hw_id,sender_id,recipient_id,secret,salt,transport
   nrf9151-002,02,,0102030405060708090a0b0c0d0e0f10,9e7ca92223786340,tn
   EOF
   ```
   Putting it under `/pb_data` keeps it on the volume (survives redeploys) and,
   because it contains master secrets, off the host's ephemeral layer.
3. Import it:
   ```sh
   oscore-server provision --csv /pb_data/devices.csv --dir=/pb_data
   ```
   It prints `provisioned N device(s) from ...`. The `--dir=/pb_data` is
   essential — without it the command writes to a throwaway `pb_data` next to the
   binary instead of the live database.
4. Verify in the admin UI: the `devices` and `oscore_contexts` collections now
   hold the new rows (`oscore_contexts.master_secret_enc` is the wrapped blob,
   never the plaintext secret).

Re-running with the same `hw_id` updates that device's context rather than
duplicating it, so the CSV is safe to re-apply. Delete the CSV afterward
(`rm /pb_data/devices.csv`) if you'd rather not leave secrets on the volume.

## Fly.io

UDP on Fly is workable but finicky — `fly.toml` already encodes the two
requirements: bind to `fly-global-services` (set via `OSCORE_COAP_ADDR`) and
declare a TCP handler on the same UDP port.

```sh
cd go
fly launch --no-deploy           # or `fly apps create oscore-poc` if app exists
fly volumes create pb_data --region arn --size 1
fly secrets set PB_OSCORE_KEK=$(openssl rand -hex 32)
fly deploy
```

Then create the superuser:

```sh
fly ssh console -C "oscore-server superuser upsert you@example.com 'a-strong-password' --dir=/pb_data"
```

Notes:
- Keep `min_machines_running = 1` / `auto_stop_machines = false`: devices push
  uplinks at any time, and the `pb_data` volume + OSCORE state can't be sharded
  across machines. Run a single instance.
- Devices connect to the CoAP UDP service at `<app>.fly.dev:5683`.
- If UDP packets don't arrive, confirm the process logs
  `listening on udp fly-global-services:5683` (not `:5683`).

## Provisioning devices

Devices and their OSCORE security contexts are imported from a CSV with a header
row, via the `provision` subcommand. The command validates the key material,
KEK-encrypts the master secret, and writes the `devices` + `oscore_contexts`
rows. It is **idempotent on `hw_id`** — re-importing the same `hw_id` updates that
device's single context in place rather than creating a duplicate.

```sh
oscore-server provision --csv /pb_data/devices.csv --dir=/pb_data
```

Always pass `--dir=/pb_data` so it writes to the live database (the same volume
the server uses), and run it with the same `PB_OSCORE_KEK` as the server.

### CSV columns

Header names are case-insensitive and may appear in any order; hex fields follow
the aiocoap `settings.json` conventions.

| Column         | Required | Meaning                                                        |
| -------------- | -------- | -------------------------------------------------------------- |
| `hw_id`        | yes      | Hardware/device identifier; the upsert key (e.g. `nrf9151-001`). |
| `secret`       | yes      | OSCORE master secret, hex.                                     |
| `salt`         | no       | OSCORE master salt, hex.                                       |
| `sender_id`    | no       | Server's Sender ID, hex.                                       |
| `recipient_id` | no       | The wire `kid` (the device's Sender ID), hex. Stored as `oscore_contexts.kid`. |
| `id_context`   | no       | OSCORE ID Context, hex. Stored as `oscore_contexts.kid_context`. |
| `transport`    | no       | Free-form transport tag; defaults to `unknown`.               |

Example (`devices.csv`):

```csv
hw_id,sender_id,recipient_id,secret,salt,transport
nrf9151-001,01,,0102030405060708090a0b0c0d0e0f10,9e7ca92223786340,tn
```

Bad key material (e.g. equal sender/recipient IDs) is rejected before anything
is written. The plaintext master secret is never stored — only the wrapped
`oscore_contexts.master_secret_enc` blob.

### Generating a device over HTTP (`POST /api/provision`)

Instead of hand-authoring a CSV, a superuser can mint a device with
server-generated key material in one call. The server picks a free random wire
`kid` (2 bytes, or 3 then 4 once the shorter space is crowded; the kid is sent in
every request, so shorter saves airtime) that never equals `sender_id`, a random
16-byte master secret and 8-byte salt, KEK-encrypts the secret, and
returns the **plaintext material once** so you can load it onto the device at the
bench. All body fields are optional (`hw_id`, `sender_id`, `transport`); an empty
body auto-generates an `hw_id`.

```sh
# Authenticate as a superuser, then provision:
TOKEN=$(curl -s -X POST "$BASE/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d '{"identity":"admin@example.com","password":"..."}' | jq -r .token)

curl -s -X POST "$BASE/api/provision" -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"transport":"tn"}'
# -> {"hw_id":"nrf9151-50cc94ae","sender_id":"01","recipient_id":"3a7f",
#     "master_secret":"…","master_salt":"…","alg":"AES-CCM-16-64-128"}
```

It reuses the same pipeline as the CSV path (idempotent on `hw_id` — re-posting an
existing `hw_id` **rotates** that device's key material in place). The returned
material is shown only in this response; capture it then.

## Building the image directly

```sh
cd go
docker build -t oscore-server:latest --build-arg VERSION=$(git rev-parse --short HEAD) .
```

## FOTA (firmware over the air)

Collections added in Phase 7:

| Collection | Purpose |
|---|---|
| `firmware_images` | Uploaded blobs: `application`, `modem_delta`, `modem_full`, `bootloader` |
| `fota_jobs` | Per-device job state machine linked to a device + image |

**Operator workflow**

1. Upload an image via admin UI → `firmware_images` (file, version, type, optional `hw_rev`).
2. Create `fota_jobs` for the target device(s). One in-flight job per device is enforced.
3. Devices learn about pending jobs from the telemetry envelope (flag bit1) and pull
   via OSCORE `GET /f` + Block2 `GET /f/i`.

**Image types**

- `application` — MCUboot application binary (e.g. `zephyr.signed.bin` or `dfu_application.zip` contents).
- `bootloader` — MCUboot slot update (`dfu_mcuboot.zip`).
- `modem_delta` / `modem_full` — Nordic modem firmware binaries; obtain from Nordic
  out-of-band and upload like any other image (not redistributed by this platform).

A job's `allowed_transports` (default `[tn]`, also for rollout-created jobs) gates image download; other transports get `4.06` on `/f/i`. Set `allowed_transports` on a rollout to allow more bearers for its jobs.

## Location resolution (cell/Wi-Fi)

A device that gets no GNSS fix reports its serving/neighbor cells and a Wi-Fi AP
scan folded into telemetry (CBOR keys `5`/`6`). These land as **positionless**
`location_fixes` rows (`method` = `cell`/`wifi`/`combined`, `source` = `device`,
raw measurements, no lat/lon). When `GOOGLE_GEOLOCATION_API_KEY` is set, the
server resolves them to coordinates cloud-side via the
[Google Geolocation API](https://developers.google.com/maps/documentation/geolocation/overview).

| Env var | Purpose |
| ------- | ------- |
| `GOOGLE_GEOLOCATION_API_KEY` | API key for `geolocation/v1/geolocate`. Unset ⇒ resolution is **disabled** (the startup log says so); scans are still stored, just never positioned. |

**Getting the key.** In Google Cloud Console: enable the **Geolocation API** for a
project, then create an API key (APIs & Services → Credentials). Restrict it to
the Geolocation API. Billing must be enabled on the project. Set it as a
secret/runtime env var the same way as `PB_OSCORE_KEK` (Coolify Environment
Variables, `fly secrets set`, or Compose env) — it is read at startup only.

**How it resolves.** Resolution is asynchronous and best-effort, off the device
uplink path:

- A create hook resolves each new scan immediately; a `*/5` cron sweeps any rows
  missed by a restart or a transient failure.
- The serving cell maps to one LTE `cellTowers` entry and each Wi-Fi AP to a
  `wifiAccessPoints` entry; `considerIp` is forced `false` so devices are never
  placed at the server's IP. Neighbor cells are dropped (no cell id → unusable by
  Google).
- **Success:** the same row is filled in place — `lat`/`lon`/`accuracy_m` set,
  `source` becomes `google`, `resolved_at` stamped — and fires the
  `location.resolved` webhook.
- **No result / too little data** (no cell and fewer than 2 Wi-Fi APs): stamped
  `resolved_at` with no position, and not retried.
- **Transient error** (network/HTTP): left unresolved for the next cron sweep.

No new ports or volumes are needed; resolution writes through the existing
`/pb_data` database and the webhook outbox.

## A-GNSS assistance

The device requests GNSS assistance over OSCORE CoAP `POST /a` and receives a
CBOR bundle over Block2 (see [agnss-design.md](../docs/agnss-design.md) and
[agnss-schema.md](../docs/agnss-schema.md)). The device contract is frozen; only the
server-side assistance *source* changes between phases.

### Phase 1 — SUPL (default, serves devices)

The server runs a SUPL/RRLP session to a public SLP and maps the result to the
bundle. Enabled by default.

| Env var | Purpose |
| ------- | ------- |
| `AGNSS_DISABLE` | `1` makes `/a` answer `5.03` (assistance off). |
| `AGNSS_SOURCE` | Which provider devices receive: `supl` (default, public SLP) or `rtcm` (home-built, requires `AGNSS_NTRIP_URL` — see Phase 2 below). |
| `AGNSS_SLP_HOST` | SLP `host:port` override (default `supl.google.com:7275`). |
| `AGNSS_SUPL_CELL` | `"mcc,mnc,lac,ci"` GSM cell seed for the SUPL LocationId. |
| `AGNSS_SUPL_DEBUG` | `1` hex-dumps ULP PDUs. |
| `AGNSS_PRUNE_DISABLE` | `1` disables satellite pruning (serve the full constellation). Pruning is on by default. |
| `AGNSS_PRUNE_WINDOW` | Look-ahead window for SV visibility, a Go duration (default `2h`). |
| `AGNSS_PRUNE_MASK_DEG` | Elevation mask in degrees at zero position uncertainty (default `5`). |
| `AGNSS_PRUNE_MIN_SV` | Never prune below this many satellites (default `8`). |

Satellite pruning drops ephemerides for satellites that will not be visible from
the device's coarse position over the look-ahead window, so the Block2 download
shrinks with position accuracy (a GNSS/cell hint prunes hard; a country-code hint
keeps most SVs). The device may send the position hint in its request (`lat`/`lon`,
a serving cell `mcc`/`mnc`/`tac`/`ci`, or a bare `mcc`); otherwise the server uses
the device's last-known fix. Resolving a serving-cell hint reuses the same
`GOOGLE_GEOLOCATION_API_KEY` geolocator as location resolution; without it, cell
hints fall back to a country centroid or the last-known fix. See agnss-design.md
section 9.1.

### Phase 2 — RTCM/NTRIP (home-built assistance)

The RTCM provider sources GPS broadcast ephemeris (RTCM message 1019) from an
NTRIP caster and assembles the same bundle shape as SUPL. Set `AGNSS_SOURCE=rtcm`
(with `AGNSS_NTRIP_URL`) to have devices receive this home-built assistance
instead of SUPL; the default remains SUPL. To validate one source against the
other without swapping what devices receive, leave `AGNSS_SOURCE` as-is and set
`AGNSS_COMPARE_SHADOW=1` to run the alternate provider observe-only.

| Env var | Purpose |
| ------- | ------- |
| `AGNSS_NTRIP_URL` | Full RTCM 1019 mount URL, e.g. `http://products.igs-ip.net:2101/BCEP00BKG0`. |
| `AGNSS_NTRIP_USER` / `AGNSS_NTRIP_PASS` | Optional HTTP Basic credentials (empty attempts no-auth). |
| `AGNSS_NTRIP_BRDC_URL` | Optional daily GPS broadcast RINEX nav file for Klobuchar + UTC (RTCM 1019 carries neither). May contain the date tokens `%Y`/`%y`/`%j` (resolved to the previous UTC day per fetch). When empty and an Earthdata token is set, defaults to NASA CDDIS. |
| `AGNSS_EARTHDATA_TOKEN` | Earthdata Login bearer token. Umbrella token: makes NASA CDDIS the **primary** mirror for IGU/IGR SP3 products (BKG/IGN remain fallback) and the default BRDC source. Falls back to `AGNSS_BRDC_TOKEN` if unset. |
| `AGNSS_BRDC_TOKEN` | Legacy Earthdata bearer token for BRDC only (still honored; superseded by `AGNSS_EARTHDATA_TOKEN`). Open mirrors need none. |
| `AGNSS_BRDC_USER` / `AGNSS_BRDC_PASS` | Optional HTTP Basic credentials for BRDC mirrors that require them. |
| `AGNSS_COMPARE_SHADOW` | `1` runs the *other* provider (the one not selected by `AGNSS_SOURCE`) alongside the served one and logs per-request ephemeris agreement (observe-only). The RTCM side requires `AGNSS_NTRIP_URL`. |

#### Broadcast nav (BRDC) sources for iono/UTC

RTCM 1019 carries only ephemeris, so Klobuchar and UTC come from a daily RINEX
navigation file whose header has the iono/UTC lines (`ION ALPHA/BETA` +
`DELTA-UTC` in RINEX 2, `GPSA/GPSB IONOSPHERIC CORR` + `GPUT TIME SYSTEM CORR`
in RINEX 3). The fetcher handles plain and gzip (`.gz`) files (not Unix `.Z`).

- **NASA CDDIS (Earthdata token, default):** when `AGNSS_EARTHDATA_TOKEN` (or `AGNSS_BRDC_TOKEN`) is set and `AGNSS_NTRIP_BRDC_URL` is empty, the server uses the CDDIS daily merged nav template `https://cddis.nasa.gov/archive/gnss/data/daily/%Y/brdc/BRDC00IGS_R_%Y%j0000_01D_MN.rnx.gz`, resolved to the previous UTC day each fetch. Generate a token at Earthdata Login (Profile -> Generate Token); the client follows CDDIS's redirect chain while preserving the bearer token.
- **Open mirrors (no auth, fallback):** set `AGNSS_NTRIP_BRDC_URL` explicitly to BKG `https://igs.bkg.bund.de/root_ftp/IGS/BRDC/YYYY/DDD/BRDC00WRD_R_YYYYDDD0000_01D_MN.rnx.gz` or IGN `https://igs.ign.fr/pub/igs/data/YYYY/DDD/`.

#### P-GPS predicted-orbit products (IGU/IGR SP3)

P-GPS is off by default; set `PGPS_ENABLE=1` to serve `/p`. Its caches live
under the data directory (`--dir`, `/pb_data` in the container) as `gnss/` and
`pgps/`, or under `PGPS_DATA_DIR` when set. Deployments that relied on the old
default (on, caches under `./pb_data` relative to the working directory, which
was `/pb_data/pb_data` in the container) must set `PGPS_ENABLE=1`, and either
move those two directories up one level or set `PGPS_DATA_DIR` to the old path
to keep the window archive.

The predicted-orbit path (CODE 5D + IGU) and the periodic IGR backtest fetch IGS
SP3 products. When `AGNSS_EARTHDATA_TOKEN` (or `AGNSS_BRDC_TOKEN`) is set, NASA
CDDIS (`https://cddis.nasa.gov/archive/gnss/products/<gpsweek>/`) is tried
first, with BKG/IGN as automatic fallback; CODE 5D stays on AIUB. The
`pgps-orekit` GitHub Actions workflow does the same when the repo secret
`EARTHDATA_TOKEN` is configured (Settings -> Secrets and variables -> Actions).

The backtest scores every predicted window still on disk (all generations)
against all IGR arcs that now cover it, so measured horizons accumulate to the
full truth span instead of stalling at day 1. Window files are kept for
`PGPS_ARCHIVE_RETENTION` (default 21 days) independently of serving
`PGPS_GC_GRACE`; the run cadence is `PGPS_BACKTEST_EVERY` (default 6h), and the
IGU observed segment is used as a low-latency bridge unless `PGPS_TRUTH_IGU=0`.
To populate the horizon curve from existing history without waiting (or to
re-score a past window after a fix), run the backfill subcommand:

```
oscore-server pgps-backfill --dir /pb_data --dry-run   # preview per-horizon stats
oscore-server pgps-backfill --dir /pb_data             # upsert pgps_backtest rows
```

Recommended ephemeris mounts (all carry RTCM 1019; most need free registration):

- `products.igs-ip.net:2101` mount `BCEP00BKG0` (BKG, GPS+GLO+GAL+BDS+QZS)
- `wox.geopp.de:2101` mount `WW_EPH` (Geo++)
- `ntrip.gnssonline.eu` mount `RTCM3EPH` (Alberding)

Casters must speak NTRIP 2.0 (HTTP). The mount is swappable via `AGNSS_NTRIP_URL`;
the device never knows which caster served it.

### Comparing SUPL vs RTCM (no hardware)

The `agnss-bench` tool fetches the same request from both providers and reports
field-level ephemeris agreement:

```sh
cd go
go run ./cmd/agnss-bench -compare \
  -ntrip-url http://products.igs-ip.net:2101/BCEP00BKG0 \
  -ntrip-user "$AGNSS_NTRIP_USER" -ntrip-pass "$AGNSS_NTRIP_PASS" \
  -brdc-url https://cddis.nasa.gov/archive/gnss/data/daily/2026/brdc/brdc1750.26n.gz \
  -brdc-token "$AGNSS_BRDC_TOKEN" \
  -lat 59.91 -lon 10.75 -min-overlap 8
```

Omit `-brdc-url` to skip iono/UTC (the RTCM bundle then reports
`Ionospheric: false`); use an open mirror URL instead of CDDIS to drop the
`-brdc-token`.

It exits non-zero if fewer than `-min-overlap` satellites overlap or any
positioning-critical ephemeris field (clock + Kepler parameters) disagrees.
Differences in the housekeeping flags `ura`, `fit_int` and `health` are reported
as WARN, not failures: a derived SUPL source (e.g. Google) commonly normalizes
these while the verbatim RTCM broadcast carries the true values. The same path
runs as a live test:

```sh
AGNSS_COMPARE_LIVE=1 AGNSS_NTRIP_URL=http://host:port/MOUNT \
  AGNSS_NTRIP_USER=u AGNSS_NTRIP_PASS=p \
  go test -run TestLiveCompare -v ./internal/platform/agnss/bench/
```

To validate the RTCM decoder against a captured frame, capture a golden fixture
once with `AGNSS_CAPTURE=1` (writes `internal/platform/agnss/rtcm/testdata/`),
then `TestGolden1019Decode` runs offline thereafter.

## Troubleshooting

**`unable to open database file (14)`, looping on restart.** SQLite can't open
`data.db` because the mounted `/pb_data` is not writable by the container's `app`
user. The bundled `entrypoint.sh` normally fixes this by `chown`ing the volume at
startup, so check:
- You're running an image that includes the entrypoint (rebuild + push if you
  deployed an older one), and the platform hasn't overridden the entrypoint or
  forced a non-root, non-zero container UID (see
  [Container user & volume permissions](#container-user--volume-permissions)).
- The volume is genuinely mounted at `/pb_data` (not a sub-path), and the host
  path/disk isn't read-only or full.

**Provisioned devices vanish after redeploy, or the admin login resets.** State
isn't landing on the persistent volume — almost always a missing `--dir=/pb_data`
(the default writes next to the binary) or the persistent volume wasn't attached
before first boot. Confirm `data.db` lives under the mounted `/pb_data`.

**Devices can't reach the CoAP server, but the admin UI works.** The HTTP port is
proxied but `5683/udp` isn't. Confirm the raw UDP port mapping (Coolify) or the
`udp` service + `fly-global-services` bind (Fly), and that `5683/udp` is open in
the firewall.
