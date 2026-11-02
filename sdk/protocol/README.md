# Device wire contract

This is the contract between device firmware and the joncloud IoT server. It
covers every CoAP resource a device calls, every CBOR map it sends or
receives, and every response code it must handle.

- Wire version: **1**
- Spec revision: **1.2**
- Machine-readable shapes: [`device.cddl`](device.cddl) (RFC 8610 CDDL)
- A-GNSS and P-GPS response bodies: `docs/agnss-schema.md` in the server
  repository (sections 1.2, 1.4 and 3.2)

The CDDL file is normative for message shapes. This file is normative for
behavior. Where a value is platform-specific, both files show the reference
platform `nordic-nrf91`. Where a key can be remapped by a device profile, both
show the default profile.

## Contents

1. [Transport](#transport)
2. [Versioning](#versioning)
3. [Resources](#resources)
4. [Response codes](#response-codes)
5. [Telemetry and check-in: POST /t](#telemetry-and-check-in-post-t)
6. [Queue-mode envelope](#queue-mode-envelope)
7. [Shadow: GET and POST /s](#shadow-get-and-post-s)
8. [FOTA: GET and POST /f, GET /f/i](#fota-get-and-post-f-get-fi)
9. [Coredump upload: POST /c](#coredump-upload-post-c)
10. [A-GNSS and P-GPS: POST /a and POST /p](#a-gnss-and-p-gps-post-a-and-post-p)
11. [Smoke resources: GET /hello and GET /time](#smoke-resources-get-hello-and-get-time)
12. [Operator routes](#operator-routes)
13. [Device profiles and remapping](#device-profiles-and-remapping)
14. [How the spec stays true](#how-the-spec-stays-true)
15. [Changelog](#changelog)

## Transport

- CoAP over UDP (RFC 7252). The server listens on port 5683 by default.
- Every request must be OSCORE-protected (RFC 8613). The server finds the
  security context by the request's kid. The device identity comes from that
  context, never from the payload.
- Uri-Path is one or two short segments (`t`, `s`, `f`, `f/i`, `c`, `a`, `p`).
  Short paths keep the encrypted options small. A deployment's
  [operator routes](#operator-routes) use longer paths.
- Block-wise transfer (RFC 7959) uses inner, protected Block1 and Block2
  options.
- Payloads are CBOR (RFC 8949). Send Content-Format 60 (`application/cbor`).
  Telemetry may instead use 112 (`application/senml+cbor`).

### CBOR rules

The server decoder is strict. It rejects, with 4.00:

- indefinite-length items,
- map keys that are not integers or text strings,
- bytes after the top-level item,
- simple values other than false, true, null and undefined.

It accepts half, single and double floats. It strips tags and keeps the tagged
value. It turns integer map keys into decimal strings, so integer key `1` and
text key `"1"` mean the same thing to the server. Send integer keys where this
spec shows integers and text keys where it shows text anyway. Other decoders,
including the reference firmware, do not treat them as equal.

### Confirmable and non-confirmable

A Non-confirmable POST /t gets no response at all, even when something is
pending. The data is still stored. A device on NON learns about pending work
from its next Confirmable uplink or from GET /s and GET /f. Send at least the
first check-in after boot as Confirmable, so a version mismatch reaches you.

## Versioning

### The version key

The device declares the major wire version it speaks in its compact check-in.
The default key is telemetry key `7`. A profile can move it (see
[Device profiles](#device-profiles-and-remapping)).

| Device sends | Server treats the uplink as |
|---|---|
| no key 7 | version 1 |
| `7: 1` | version 1 |
| `7: N`, N not supported | unsupported (see below) |
| `7: 0`, or not an unsigned integer | malformed, 4.00 with no payload |

A SenML uplink (Content-Format 112) cannot carry the key. It is read as
version 1 and does not change the version recorded for the device.

On every accepted compact check-in the server stores the declared version in
the device record field `devices.wire_version`. Version 1 devices that omit
the key are recorded as 1. A device that has not checked in since the server
upgrade shows 0.

A device that speaks version 2 or later must send the key in every compact
check-in. A version 1 device may omit it and save two bytes.

### Unsupported major

When a device declares a major the server does not support, the server:

1. answers 4.00 Bad Request with this diagnostic payload (UTF-8 text):
   `unsupported wire version <N>; supported <list>`. `<list>` is the
   supported majors in decimal, comma-separated, oldest first. Example:
   `unsupported wire version 2; supported 1`.
2. does not store the telemetry, location or diagnostics in that uplink.
3. records N in `devices.wire_version`, so operators can find devices that
   are ahead of the server.
4. writes an audit event of type `device.wire_version_unsupported` with
   severity `warning` and data `{wire_version, supported}`. It writes at
   most one per device per hour.

Rejecting is deliberate. A new major can change what a key means. Storing a
version 2 payload as version 1 would record wrong data without anyone
noticing. The diagnostic lets firmware that also speaks an older major fall
back: parse `<list>`, pick the highest major you implement, and resend. If you
implement none of them, stop sending and retry after a long backoff.

### Why the server does not advertise its version

The server does not add its version to the envelope or to GET /hello.

- The empty "nothing pending" response is about 15 bytes on the wire. Adding
  a version would grow every response to every uplink, which costs real
  money on NTN links.
- A device only needs the server's version when it differs from its own. The
  4.00 diagnostic carries the supported list at exactly that moment.
- A server upgrade keeps every older major it supported. A device never needs
  to probe before sending.
- GET /hello returns a fixed string that interop tests compare.

### Compatibility rules

The spec revision is `major.minor`. The major is the wire version a device
declares. The minor counts compatible additions within that major.

A **minor** change keeps every existing device working. Examples:

- a new optional key in any map,
- a new resource,
- a new value in a server-side enum the device never receives (for example a
  new reset reason a device may start sending),
- a new response code for a condition that used to be impossible.

A **major** change can break an existing device. Examples:

- removing or renaming a key, or changing its CBOR type or meaning,
- changing the meaning of an enum value,
- making an optional key required,
- a new value in an enum the device receives (FOTA image type, transport),
  unless the device is told to ignore unknown values,
- changing a path, method, Content-Format or Block2 behavior,
- changing the envelope layout or the 64 byte inline delta limit.

Both sides ignore map keys they do not know. The server keeps unknown
telemetry keys verbatim in `telemetry.data`. Firmware must skip unknown keys
in the envelope, the shadow delta and the FOTA notice. That rule is what makes
an added key a minor change.

Remapping keys in a device profile is a per-product setting, not a version
change.

## Resources

| Method and path | Request body | Success response |
|---|---|---|
| POST `/t` | `telemetry` (CF 60) or `senml-pack` (CF 112) | 2.04, `envelope` or empty |
| GET `/s` | none | 2.05, `shadow-delta` or empty |
| POST `/s` | `shadow-report` | 2.04, `envelope` or empty |
| GET `/f` | none | 2.05, `fota-notice` or empty |
| POST `/f` | `fota-report` | 2.04, `envelope` or empty |
| GET `/f/i` | none, Block2 option | 2.05, image bytes (CF 42), Block2 |
| POST `/c` | coredump bytes, Block1 option | 2.31 per block, 2.04 at the end |
| POST `/a` | `agnss-request` in block 0 | 2.05, assistance CBOR, Block2 |
| POST `/p` | `pgps-request` in block 0 | 2.05, predicted assistance CBOR, Block2 |
| GET `/hello` | none | 2.05, `Hello World!` |
| GET `/time` | none | 2.05, UTC time text |
| any of GET, POST, PUT, DELETE on an operator route | defined by the deployment | 2.01 to 2.05, as the route answers |

The names in the body columns are CDDL rules in `device.cddl`.

## Response codes

| Code | Where | Meaning for the device | What to do |
|---|---|---|---|
| 2.04 Changed | POST /t, /s, /f, last block of /c | Accepted. Payload is an `envelope`, or empty when nothing is pending. | Act on the envelope. |
| 2.05 Content | GET /s, /f, /f/i, /hello, /time; POST /a, /p | Here is the data. An empty 2.05 from GET /s or GET /f means nothing is pending. | Read the payload. |
| 2.31 Continue | POST /c | Block stored, send the next one. | Send the next block. |
| 4.00 Bad Request | any | The outer message could not be read, or the payload is malformed, or a rule was broken (illegal FOTA transition, no active FOTA job, unsupported Block2 size). On POST /t with a diagnostic payload: unsupported wire version. | Do not resend the same payload. For the version case, see [Unsupported major](#unsupported-major). |
| 4.01 Unauthorized | any | The request is not OSCORE-protected, the kid is unknown, the sequence number was replayed, or decryption failed. The response is not OSCORE-protected. | Check your security context. After a replay, advance your sender sequence number. |
| 4.04 Not Found | GET /f/i; unknown paths | No active FOTA job, or no such resource. | Stop the download. Check GET /f. |
| 4.05 Method Not Allowed | /s, /f, /f/i, /a, /p, operator routes | Wrong method for the path. | Fix the firmware. |
| 4.06 Not Acceptable | GET /f/i | The job's `allowed_transports` excludes your current bearer. Jobs default to `tn` only. | Retry the download on an allowed bearer. Report your bearer in key 1. |
| 4.08 Request Entity Incomplete | POST /c, /a, /p | /c: a block arrived out of order. /a and /p: a block after 0 arrived but the server has no cached response for you. | Restart the transfer from block 0. |
| 4.13 Request Entity Too Large | POST /c | The coredump would exceed 1 MiB. | Stop. Do not retry this coredump. |
| 5.00 Internal Server Error | any | Server fault, including a FOTA image whose type your platform does not support, and an operator route that failed or whose response would exceed its size limit. | Retry later with backoff. |
| 5.02 Bad Gateway | POST /a | The upstream assistance source failed, or the request body could not be decoded. | Retry later. Check the request body. |
| 5.03 Service Unavailable | POST /a, /p | A-GNSS or P-GPS is disabled on this server, or your platform has no GNSS codec. | Do not retry soon. Fall back to an unassisted fix. |
| 5.03 Service Unavailable, Max-Age | POST /t, operator routes | The server's extension code is busy or ran out of time for this request. | Retry after Max-Age seconds (2 today). |

Two code paths are worth knowing. POST /t, POST /s and POST /f answer 4.00
when the server fails to store an accepted payload, not 5.00. And POST /t does
not check the method: any method on `/t` is treated as POST.

## Telemetry and check-in: POST /t

The compact form is one CBOR map with integer keys (CDDL rule `telemetry`).
Every key is optional. Reserved keys in the default profile:

| Key | Profile field | CBOR type | Meaning |
|---|---|---|---|
| `1` | `transport` | uint | Current bearer. `1` = tn, `2` = ntn. |
| `2` | `fw_version` | tstr | Running firmware version. |
| `3` | `ts` | uint | Device clock, epoch seconds. Sets the sample time. |
| `4` | `location` | map | GNSS fix (rule `location`). |
| `5` | `cell` | map | Serving cell scan (rule `cell`). |
| `6` | `wifi` | array | Wi-Fi scan (rule `wifi`). |
| `7` | `wire_version` | uint | Wire major version the device speaks. Absent means 1. |
| `20` | `reset_report` | map | Boot report (rule `reset-report`). |
| `21` | `vitals` | map | Health heartbeat (rule `vitals`). |
| `22` | `crash` | map | Minimal crash report (rule `crash`). |
| `23` | `device_info` | map | Static identity, once per boot (rule `device-info`). |

Any other unsigned integer key is a product metric. The server also stores
text keys, but no profile can chart them. The default profile charts keys 10 to 14
(battery, temperature, humidity, pressure, battery voltage). The server stores
the whole decoded map in `telemetry.data`, with integer keys as decimal
strings.

What the server does with a compact check-in:

1. Rejects the uplink if the wire version is malformed or unsupported.
2. Stores one `telemetry` row. Its time is key 3 when present, else the
   receive time. Its transport is key 1, else the device's last known bearer.
3. Updates the device: `last_seen` always; `transport`, `fw_version` and
   `wire_version` when reported; `board`, `modem_fw`, `imei`, `iccid` from
   key 23.
4. Stores key 4 as a `location_fixes` row with method `gnss`. A fix without
   both `la` and `lo` is dropped.
5. Stores keys 5 and 6 as one positionless `location_fixes` row (method
   `cell`, `wifi` or `combined`) for later cloud resolution.
6. Stores key 20 as a `device_resets` row, key 21 as a `device_metrics` row
   and key 22 as a `crash_reports` row.
7. Answers 2.04 with the envelope.

Steps 4 to 6 are best effort. A malformed sub-map is logged and skipped. The
telemetry row is kept.

An unknown transport code leaves the bearer unchanged.

### Sub-maps

Sub-map keys are short text strings. They are fixed by the platform, not by
the profile. Full shapes are in the CDDL rules named below.

- `location`: `t` fix time (epoch s), `la` and `lo` degrees (required), `ac`
  accuracy m, `tf` time to fix ms, `al` altitude m.
- `cell`: `ci`, `mcc`, `mnc`, `tac`, `ea`, `rp`, `rq`, `ta`, `nc` (neighbors,
  at most 10). Cloud resolution reads `ci`, `mcc`, `mnc`, `tac`, `rp`, `ta`.
  A scan with no `mcc` resolves only from Wi-Fi.
- `wifi`: an array of `{m: 6-byte MAC, r: RSSI dBm}`, at most 10. Cloud
  resolution needs at least two APs when there is no cell.
- `reset-report`: `hc` hardware reset-cause bitmap, `rs` reset reason, `up`
  previous uptime s, `bc` boot counter, `cp` crash pending. At least one of
  `hc` and `rs` is required. The reason enum and cause bits are in the CDDL.
- `vitals`: a non-empty map of text keys, stored verbatim. The server reads
  none of them. The reference firmware's keys are in `docs/OBSERVABILITY.md`.
- `crash`: `pc` (required), `ft` fault type, `lr`, `rg` registers, `st` stack
  candidates, `bi` GNU build-id hex, `bc` breadcrumb text. The server
  symbolicates `pc`, `lr` and `st` against the firmware ELF matching `bi`.
- `device-info`: `bd` board, `mf` modem firmware, `im` IMEI, `ic` ICCID.
  Empty strings are ignored.

### SenML

With Content-Format 112 the body is a SenML pack (RFC 8428). It is stored
verbatim. It carries no check-in fields, so the device record only gets
`last_seen`.

## Queue-mode envelope

The 2.04 answer to POST /t, POST /s and POST /f may carry a CBOR map (rule
`envelope`). It tells a sleepy device about pending work without a poll.

| Key | Type | Meaning |
|---|---|---|
| `1` | uint | Pending flags. Bit 0: a shadow delta is waiting. Bit 1: a FOTA job is active. |
| `2` | map | The shadow delta inline (rule `shadow-delta`). Only sent when it encodes to 64 bytes or less. |

An empty 2.04 with no payload means nothing is pending. Bit 0 without key 2
means the delta was too big: fetch it with GET /s. Bit 1 means: call GET /f.

## Shadow: GET and POST /s

The shadow has a `desired` half (set by the cloud) and a `reported` half (set
only by the device). Each has a version. A delta is pending exactly when the
desired version is greater than the reported version.

- GET /s answers `{1: desired_version, 2: diff}`. The diff holds every
  desired top-level key whose value is missing from or different in
  reported. No pending delta gives an empty 2.05.
- POST /s sends `{1: version, 2: state}`. Key 1 is required. It becomes the
  reported version. Send the desired version you applied. Key 2 is optional.
  Its top-level keys are merged into reported, replacing old values. The
  answer is the envelope, which can already carry a newer delta.

## FOTA: GET and POST /f, GET /f/i

GET /f answers the active job (rule `fota-notice`):

| Key | Type | Meaning |
|---|---|---|
| `1` | tstr | Job id. |
| `2` | tstr | Image version. |
| `3` | uint | Image size, bytes. |
| `4` | bstr | SHA-256 of the image, 32 bytes. |
| `5` | uint | Image type: 1 application, 2 modem delta, 3 modem full, 4 bootloader. |

No active job gives an empty 2.05. The first GET /f moves the job from
`pending` to `notified`.

GET /f/i downloads the image with Block2. Accepted block sizes are 256, 512
and 1024 bytes (SZX 5, 6, 7). No Block2 option means block 0 of 512 bytes.
Any block request moves a `pending` or `notified` job to `downloading`. A
block past the end is an empty final block.

POST /f reports progress (rule `fota-report`): `1` state (required), `2`
blocks done, `3` error text. State codes: 1 pending, 2 notified, 3
downloading, 4 downloaded, 5 applying, 6 succeeded, 7 failed, 8 cancelled,
9 timed out. Allowed moves:

| From | To |
|---|---|
| pending | notified |
| notified | downloading |
| downloading | downloaded |
| downloaded | applying |
| applying | succeeded |

Any non-final state can also move to failed, cancelled or timed out.
Repeating the current state is allowed. Any other move is 4.00. Reporting
`succeeded` for an application image sets the device's `fw_version` to the
image version.

## Coredump upload: POST /c

POST /c uploads a full coredump as raw bytes in Block1 blocks, in order from
block 0. Each block but the last gets 2.31. The last gets 2.04. The server
attaches the dump to the device's newest crash report without one, or creates
a crash report. The limit is 1 MiB. A transfer with no new block for 5
minutes is dropped. No Block1 option means the whole dump is in one request.

The reference firmware uploads coredumps only on a terrestrial bearer. The
server does not enforce this.

## A-GNSS and P-GPS: POST /a and POST /p

Both use Block2 for the response. Block 0 carries the CBOR request. Later
blocks carry no body. The server builds the response once, at block 0, and
keeps it for you for 2 minutes so the later blocks match.

- The `/a` request is rule `agnss-request`. Key `t` (the assistance type
  bitmask) is required. Location hints (`lat`, `lon`, `unc`, or a serving
  cell) shrink the response.
- The `/p` request is rule `pgps-request`. Every key is optional.
- Response bodies are specified field by field in `docs/agnss-schema.md`
  sections 1.2 (text keys), 1.4 (compact, `e: 1`) and 3.2 (P-GPS).

Both decoders ignore unknown request keys.

## Smoke resources: GET /hello and GET /time

Both sit behind OSCORE like everything else. They are for bring-up and
interop tests.

- GET /hello answers the text `Hello World!`.
- GET /time answers the server's UTC time as text, for example
  `2026-10-31T22:05:00Z`.

## Operator routes

A deployment can serve its own resources on the same port, registered with
`$iot.coapRoute` in its server hooks. `GET /cmd` and `POST /cmd/ack` in the
acme-thermo example are one such pair. This contract does not define their
bodies; the deployment documents them. It does fix how they behave:

- They are OSCORE-protected like every other resource. A request without a
  valid security context answers 4.01 and reaches no route code.
- They never take a core path. Any path whose first segment is one character
  is reserved for this contract, and so are `/hello`, `/time` and
  `/.well-known`. A new core resource can therefore never collide with a
  deployed route.
- A path has 1 to 8 segments of `A-Z a-z 0-9 . _ ~ -`. The methods are GET,
  POST, PUT and DELETE. A route's other methods answer 4.05.
- The response is a single message of at most 1024 bytes (the deployment may
  set less); there is no Block2. An object body is CBOR (CF 60) unless the
  route says otherwise.
- A route that fails answers 5.00. A route that is busy or runs out of time
  answers 5.03 with Max-Age: retry after that many seconds.
- A NON request gets no response.
- The response carries no queue-mode envelope. Pending shadow and FOTA work is
  still announced only on the 2.04 to POST /t.

## Device profiles and remapping

A device profile (a `device_profiles` record, schema in
`../schemas/device_profile.schema.json`) lets a product use different top-level
telemetry keys without a server change. A profile can move exactly the eleven
keys in the [telemetry table](#telemetry-and-check-in-post-t), using the
profile field names shown there. Omitted fields keep their defaults.

A profile cannot change:

- sub-map keys inside location, cell, Wi-Fi, reset report, vitals, crash and
  device info,
- the envelope, shadow and FOTA maps,
- the A-GNSS and P-GPS requests.

The profile's platform decides the platform-specific values: transport codes,
reset reasons, hardware cause bits, FOTA image types and device-info
sub-keys. A profile can also name an uplink codec for a payload that is not
this CBOR map at all.

## How the spec stays true

Go tests parse `device.cddl` and this file's telemetry table and compare them
with the server code. They fail when a key, enum value, flag bit or the
current version differs, and when an encoder emits a key the spec does not
define.

- `go/internal/platform/deviceapi/protocol_spec_test.go`
- `go/internal/platform/locsvc` and `go/internal/platform/agnss` spec tests

Run them with `go test ./internal/platform/... -run Spec` from `go/`.

## Changelog

- **1.2**: operator routes. A deployment may serve its own resources beside
  the core ones; the core reserves every one-character first path segment
  plus `/hello`, `/time` and `/.well-known`. POST /t and operator routes
  answer 5.03 with Max-Age when the server's extension code is busy.
- **1.1**: telemetry key 7 declares the wire version. The server records it
  in `devices.wire_version` and rejects unsupported majors with 4.00.
- **1.0**: the contract as shipped before versioning.
