# A-GNSS + GNSS-fix wire schema (Phase 1, frozen)

Status: authoritative contract for firmware and both Go assistance providers.
Companion to [agnss-design.md](agnss-design.md); this file pins the exact CBOR
field names, types, and the ephemeris field-to-struct mapping that every side
must agree on bit-for-bit. One CBOR field = one modem-struct field.

All maps use **text string keys** (CBOR major type 3), matching the device-side
ZCBOR codec and distinct from the FOTA integer-key maps. Numbers use the
smallest CBOR integer encoding; scaled-integer ephemeris fields are never sent
as text or float.

---

## 1. A-GNSS assistance — `POST /a` (Block2 response)

OSCORE-protected CoAP. Request body is a single CBOR map; the response is the
assistance CBOR map delivered over Block2 (RFC 7959) exactly as FOTA images are,
reusing the existing device Block2 machinery.

- Request content-format: `application/cbor` (60)
- Response content-format: `application/cbor` (60)
- Block2 sizes: 256, 512 or 1024 bytes (SZX 5, 6 or 7); no Block2 option means block 0 of 512

### 1.1 Request (device -> cloud)

| Key | Type | Req | Meaning |
|-----|------|-----|---------|
| `t` | uint | yes | Requested assistance types bitmask (see 1.3) |
| `lat` | float64 | no | Coarse latitude, degrees (last known fix) |
| `lon` | float64 | no | Coarse longitude, degrees |
| `unc` | uint | no | Position uncertainty, metres |
| `gt` | uint | no | Last-known GPS time, epoch seconds (for SV filtering) |
| `mcc` | uint | no | Mobile country code (serving cell / country-level hint) |
| `mnc` | uint | no | Mobile network code |
| `tac` | uint | no | Tracking area code |
| `ci` | uint | no | E-UTRAN cell id (serving cell) |
| `rp` | int | no | Serving RSRP, dBm |
| `ta` | uint | no | Timing advance |
| `w` | uint | no | Pruning look-ahead window, seconds. `0` = single-shot / instant visibility; absent = server default (2 h) |
| `n` | uint | no | Max satellites to return; server keeps the strongest (highest-elevation) satellite per azimuth sector. `0`/absent = uncapped |
| `e` | uint | no | Response encoding: `0`/absent = text-key maps (§1.2); `1` = compact positional arrays (§1.4) |
| `all` | bool | no | Return the full constellation: skip SV pruning entirely even when a position hint (or last-known fix) is available. The reference `loc` element is still sent when `t` requests it. Overrides `w`/`n`/`lat`/`lon`/`unc` for pruning. |

The device fills `t` from the modem's assistance-need notification. Any of three
optional location hints lets the cloud prune satellites and shrink the response
(see agnss-design.md section 9), and the response size scales with the hint's
accuracy — coarser hints keep more satellites:

1. **Coordinates** (`lat`/`lon`/`unc`) — the most precise hint; strongly
   preferred once any prior fix exists.
2. **Serving cell** (`mcc`+`mnc`+`tac`+`ci`, optionally `rp`/`ta`) — the cloud
   resolves it to a cell-accurate position via its geolocation provider.
3. **Country only** (`mcc` alone, no `ci`) — resolved to a coarse country
   centroid; keeps most satellites.

All hints are optional: a device that sends none is located from its last-known
fix on the server, and if that too is unknown the full constellation is sent. A
device that sets `all` bypasses pruning regardless of any resolved position,
returning every SV — useful for a cold start with no trusted position, for
debugging, or to compare against a P-GPS `all` (§3.1) bundle over the same SV set.
It still receives the reference `loc` when `t` requests it.

**Single-shot vs windowed.** `w` and `n` let the device trade validity for size
without server reconfiguration. A device that fetches assistance on every wake
(location cadence longer than the ephemeris validity) sends `w:0` (only the
satellites visible now) with a small `n` (e.g. 9) for a minimal, few-minutes-valid
payload. For single-shot (`w:0`) the server also raises the elevation mask to 10°
and keeps the strongest satellite per azimuth sector, so the returned set is the
few highest-signal, quick-to-acquire satellites rather than horizon-skimmers. A
device that wants a fix usable over the next couple of hours sends `w:7200` and no
`n`. See agnss-design.md section 9.

### 1.2 Response (cloud -> device)

```
{
  "clk":  { ... },                                    // GPS_SYSTEM_CLOCK_AND_TOWS
  "utc":  { ... },                                    // GPS_UTC_PARAMETERS
  "iono": { "a": [a0,a1,a2,a3], "b": [b0,b1,b2,b3] }, // KLOBUCHAR_IONOSPHERIC_CORRECTION
  "loc":  { ... },                                    // LOCATION (only if coarse pos known)
  "eph":  [ { ... per-SV ... }, ... ]                 // GPS_EPHEMERIDES
}
```

Each element is present only when the corresponding bit in the request `t` mask
was set and the provider has the data. All elements are optional; an empty map
is a valid (no-assistance) response.

#### `clk` — system clock and TOWs (`NRF_MODEM_GNSS_AGNSS_GPS_SYSTEM_CLOCK_AND_TOWS`)

Carried in the LPP-native GPS week + time-of-week shape. The modem struct
(`nrf_modem_gnss_agnss_gps_data_system_time_and_sv_tow`) is day-number +
time-of-day, so the firmware converts:
`total_s = wn*604800 + tow/1000` → `date_day = total_s/86400`,
`time_full_s = total_s%86400`, `time_frac_ms = tow%1000`. Per-SV TOW elements
(`sv_mask`/`sv_tow`) are not provided in Phase 1.

| Key | Type | Source field |
|-----|------|-------------|
| `wn` | uint | GPS week number (full, not mod-1024) |
| `tow` | uint | time of week (ms) |
| `tdu` | uint | TOW uncertainty (no modem field; ignored) |
| `clkd` | int | clock drift (no modem field; ignored) |

The server stamps `wn`/`tow` with its **current** NTP-accurate GPS time at encode
time, not the upstream provider's fetch-time reference: the modem treats this as
"now" and propagates every ephemeris to it, so a stale reference time (minutes
old on arrival) makes it discard the assistance and cold-acquire.

#### `utc` — UTC parameters (`NRF_MODEM_GNSS_AGNSS_GPS_UTC_PARAMETERS`)

| Key | Type | Modem field |
|-----|------|-------------|
| `a0` | int | `a0` |
| `a1` | int | `a1` |
| `dtls` | int | `delta_tls` |
| `tot` | uint | `tot` |
| `wnt` | uint | `wn_t` |
| `wnlsf` | uint | `wn_lsf` |
| `dn` | int | `dn` |
| `dtlsf` | int | `delta_tlsf` |

#### `iono` — Klobuchar (`NRF_MODEM_GNSS_AGNSS_KLOBUCHAR_IONOSPHERIC_CORRECTION`)

| Key | Type | Modem field |
|-----|------|-------------|
| `a` | array[4] int | `alpha0..3` |
| `b` | array[4] int | `beta0..3` |

#### `loc` — reference location (`NRF_MODEM_GNSS_AGNSS_LOCATION`)

| Key | Type | Meaning |
|-----|------|---------|
| `lat` | float64 | latitude, degrees |
| `lon` | float64 | longitude, degrees |
| `unc` | uint | uncertainty, metres |

This is the coarse position the server resolved for the device (from the request
hint, or its last-known fix). The device converts it to the modem's
semicircle/encoded-uncertainty form and injects it as reference-location
assistance before `nrf_modem_gnss_agnss_write()`, which lets the modem constrain
its Doppler/visibility search for a faster cold lock. Present only when the modem
requested position and a coarse position could be resolved.

#### `eph[]` — ephemerides (`NRF_MODEM_GNSS_AGNSS_GPS_EPHEMERIDES`)

One array entry per satellite. Fields are broadcast-scaled integers per
IS-GPS-200 and map 1:1 to `struct nrf_modem_gnss_agnss_gps_data_ephemeris`.
Each entry is written to the modem one SV at a time.

| Key | CBOR type | Modem field | Notes |
|-----|-----------|-------------|-------|
| `sv` | uint | `sv_id` | satellite PRN |
| `h` | uint | `health` | |
| `iodc` | uint | `iodc` | issue of data, clock |
| `toc` | uint | `toc` | |
| `af2` | int | `af2` | |
| `af1` | int | `af1` | |
| `af0` | int | `af0` | 22-bit signed |
| `tgd` | int | `tgd` | |
| `ura` | uint | `ura` | |
| `fi` | uint | `fit_int` | fit interval flag |
| `iode` | uint | (none) | issue of data, ephemeris; no modem field, firmware ignores |
| `crs` | int | `c_rs` | |
| `dn` | int | `delta_n` | |
| `m0` | int | `m0` | semicircles * 2^-31 |
| `cuc` | int | `c_uc` | |
| `e` | uint | `e` | eccentricity * 2^-33 |
| `cus` | int | `c_us` | |
| `sa` | uint | `sqrt_a` | sqrt(m) * 2^-19 |
| `toe` | uint | `toe` | |
| `cic` | int | `c_ic` | |
| `om0` | int | `omega0` | |
| `cis` | int | `c_is` | |
| `i0` | int | `i0` | |
| `crc` | int | `c_rc` | |
| `w` | int | `w` | argument of perigee |
| `odot` | int | `omega_dot` | |
| `idot` | int | `idot` | |

Field names/widths/signedness must be re-verified against the pinned NCS
`nrf_modem_gnss.h` for the build in use before flashing (agnss-design.md
section 12 item 2). The table above is the frozen wire contract; if a modem
field differs, change the C mapping, not the wire keys.

### 1.4 Compact encoding (`e:1`)

When the device requests `e:1`, the response uses the same top-level element
keys (`clk`/`utc`/`iono`/`loc`/`eph`) but each value is a **fixed-order CBOR
array** instead of a text-keyed map. This removes the per-field key overhead
that dominates the payload (~178 B/SV of text-key map vs ~78 B/SV positional
array), so a single-shot fetch (`w:0`, `n:9`, `e:1`) lands around 0.6–0.7 kB
versus ~1.5 kB for the same satellites in text-key form.

The array element order is **FROZEN** and mirrors §1.2 field-for-field; both the
Go encoder (`EncodeBundleCompact`) and the device decoder must agree bit-for-bit.

| Element | Array (in order) |
|---------|------------------|
| `clk` | `[wn, tow, tdu, clkd]` |
| `utc` | `[a0, a1, dtls, tot, wnt, wnlsf, dn, dtlsf]` |
| `iono` | `[a0, a1, a2, a3, b0, b1, b2, b3]` (alpha then beta, flattened) |
| `loc` | `[lat, lon, unc]` |
| `eph` | array of per-SV arrays, each: `[sv, h, iodc, toc, af2, af1, af0, tgd, ura, fi, iode, crs, dn, m0, cuc, e, cus, sa, toe, cic, om0, cis, i0, crc, w, odot, idot]` (27 elements) |

The per-SV field semantics, types, and modem-struct mapping are exactly as in
§1.2's `eph[]` table; only the encoding (positional vs keyed) differs.

### 1.3 Assistance type bitmask (`t`)

Mirror of the modem `nrf_modem_gnss_agnss_data_frame` need flags. Phase 1
uses GPS only.

| Bit | Value | Assistance type |
|-----|-------|-----------------|
| 0 | 0x01 | UTC parameters |
| 1 | 0x02 | Ephemerides |
| 2 | 0x04 | Almanac |
| 3 | 0x08 | Klobuchar ionospheric |
| 4 | 0x10 | NeQuick ionospheric |
| 5 | 0x20 | System clock and TOWs |
| 6 | 0x40 | Location |
| 7 | 0x80 | Integrity |

The device derives `t` from the `data_flags` and per-system mask in the modem's
assistance-need frame. The provider returns only the requested, available
elements.

---

## 2. GNSS fix — folded into telemetry (`POST /t`, map key 4)

A GNSS fix is **not** a separate request. The device folds it into the telemetry
uplink as a nested CBOR map under integer key `4`, so position and sensors ride
in one message (one OSCORE/CoAP/UDP overhead instead of two). The telemetry
handler writes a `telemetry` row and, when key `4` is present, also a
`location_fixes` row (firing the `location.created` webhook). The standalone
`POST /l/g` endpoint has been removed.

Key `5` carries a cell scan and key `6` a Wi-Fi scan (emitted by the cellular/
Wi-Fi location method, when enabled). They are stored as an **unresolved**
`location_fixes` row (raw measurements, no lat/lon) for a later ground-fix
resolution step; see §2.3.

Example telemetry map:

```
{ 1: <transport>, 2: "<fw>", 3: <ts>,
  10: <battery>, 11: <temp>, ...,        // sensor metrics
  4: { "t": <fix_ts>, "la": .., "lo": .., "ac": .., "tf": .., "al": .. } }
```

### 2.1 Folded fix map (key `4`)

| Key | Type | Req | Meaning |
|-----|------|-----|---------|
| `t` | uint | no | Fix time, epoch seconds (device clock; omit if unknown) |
| `la` | float64 | yes | Latitude, degrees |
| `lo` | float64 | yes | Longitude, degrees |
| `ac` | float64 | no | Horizontal accuracy, metres |
| `tf` | uint | no | Time to fix, milliseconds (search trigger -> this fix) |
| `al` | float64 | no | Altitude, metres (when PVT detail valid) |

`tf` is the key debug signal: GNSS acquisition happens outdoors where device
logs are hard to capture, so time-to-fix is carried on the wire and stored with
each fix. Correlate it with A-GNSS freshness from the PocketBase admin UI or the
`location.created` webhook without touching the device.

### 2.2 Storage (`location_fixes`)

| Column | Source |
|--------|--------|
| `device` | OSCORE-authenticated device id |
| `ts` | `t` if present, else server receipt time |
| `lat` / `lon` | `la` / `lo` |
| `accuracy_m` | `ac` |
| `alt_m` | `al` |
| `ttff_ms` | `tf` |
| `method` | `"gnss"` (fixed) |
| `source` | `"device"` (fixed) |
| `raw` | reserved (null) |

The fix's `ts` falls back to the telemetry sample time (key `3`), then to server
receipt time, when the fix carries no `t`.

### 2.3 Cell scan (key `5`) and Wi-Fi scan (key `6`)

Emitted when the cellular/Wi-Fi location method runs (the device's location
search hands the scan out for external resolution). A round produces a GNSS fix
(key `4`) **or** a cell/Wi-Fi scan, depending on which method succeeded.

Cell map (key `5`):

| Key | Type | Meaning |
|-----|------|---------|
| `ci` | uint | Serving E-UTRAN cell id |
| `mcc` / `mnc` | uint | Mobile country / network code |
| `tac` | uint | Tracking area code |
| `ea` | uint | EARFCN |
| `rp` / `rq` | int | Serving RSRP / RSRQ |
| `ta` | uint | Timing advance |
| `nc` | array | Neighbor cells: `[{ea, pci, rp, rq, td}, …]` (capped at 10) |

Wi-Fi array (key `6`): `[{m: <6-byte MAC>, r: <rssi int>}, …]` (capped at 10).

Storage: one `location_fixes` row with `method` = `cell` / `wifi` / `combined`,
`source` = `device`, `raw` = `{cell?, wifi?}` (the decoded measurements; MAC
bytes serialize as base64 in JSON), and **no** lat/lon. The row fires the
`location.created` webhook — consumers must tolerate a positionless fix (check
`method`/presence of `lat`).

**Resolution (`locsvc`, Google Geolocation API).** The positionless row is
resolved cloud-side, asynchronously, off the device uplink path. `locsvc` maps
the serving cell to one LTE `cellTowers` entry and each Wi-Fi AP to a
`wifiAccessPoints` entry (neighbor cells are dropped — they carry no cell id, so
Google cannot use them) and POSTs to `geolocation/v1/geolocate` with
`considerIp=false`. On success the same row is filled in place — `lat`/`lon`/
`accuracy_m` set, `source` becomes `google`, `resolved_at` stamped — and fires
the `location.resolved` webhook. A no-result or insufficient scan is stamped
`resolved_at` with no position (not retried); a transient failure is left for the
`*/5` cron sweep. Enabled when `GOOGLE_GEOLOCATION_API_KEY` is set.

---

## 3. Predicted GNSS assistance — `POST /p` (Block2 response)

Predicted (multi-day) assistance, delivered as ordinary IS-GPS-200 broadcast
ephemeris parameter sets — one set per SV per **4 h window** — so the device
stores a sequence of windows and, at wake, injects the one covering the current
time and fixes without contacting the cloud. Same OSCORE, same Block2 receive
path, and the same compact ephemeris encoding as §1.4. Separate resource from
`/a`. This section is **FROZEN**; the Go codec (`agnss.DecodePGPSRequest` /
`agnss.EncodePGPSResponse`) and the device must agree bit-for-bit.

### 3.1 Request (device -> cloud), CBOR map, text keys

| Key | Type | Meaning |
|-----|------|---------|
| `from` | uint | GPS time (seconds) of the first window wanted. Default: now. |
| `n` | uint | Number of consecutive 4 h windows. Default 6. Server clamps to the available horizon. |
| `at` | array of uint | Explicit GPS times; the server returns only the windows covering those instants (e.g. a known wake schedule → 2 fixes/day costs 2 windows/day). Overrides `from`/`n`. |
| `have` | array of uint | `iode` values the device already stores; the server skips them unless a newer generation exists. |
| `gen` | uint | Newest generation the device holds; the server includes a window only if its generation is newer. |
| `lat` | float | Coarse latitude (deg) for pruning, same semantics as §1.1. |
| `lon` | float | Coarse longitude (deg) for pruning. |
| `unc` | uint | Position uncertainty (m) for pruning. |
| `m` | uint | Max SVs per window (same semantics as `/a` `n`). |
| `mov` | bool | Device is mobile; the server relaxes the pruning mask (§3.3). |
| `all` | bool | Return the full constellation: skip pruning entirely, even when the server has a coarse position (device-supplied or last-known fix). Overrides `lat`/`lon`/`unc`/`m`/`mov` for pruning. |

Unknown keys are ignored. All keys are optional.

### 3.2 Response (cloud -> device), CBOR map, Block2

```
{
  "gen":  uint,                 // generation id (GPS seconds of generation)
  "next": uint,                 // GPS time when a newer generation is expected;
                                //   device need not ask before this
  "win": [
    { "toe": uint, "e": 1, "eph": [ <compact ephemeris>, … ] },
    …
  ]
}
```

- `gen` is the newest generation among the returned windows; `next` is `gen`
  plus the source cadence (device may defer re-polling until then).
- Each `win[]` entry carries `toe` (GPS seconds, the window centre), `e:1`
  (compact encoding marker), and `eph` — an array of the **same frozen 27-element
  per-SV arrays** as §1.4's `eph[]`. Field order, types, and modem-struct mapping
  are identical to §1.4; only the framing (per-window `toe` grouping) differs.
- Each SV's `iode`/`iodc` is a synthetic issue-of-data unique across the horizon
  so the device can deduplicate stored windows; `ura` reflects the predicted
  error at that horizon; `tgd` comes from the latest live broadcast (fallback 0).
- The device needs no field it does not already decode for `/a`.

### 3.3 Server-side pruning per window

The server runs `PruneBundle` on each window with the look-ahead set to the
window span (`w` = 4 h, starting at `toe − 2 h`) and the 5° mask, relaxed by
`unc` as in §1. A stationary device with a good position keeps roughly 12–16 SVs
per window. With `mov` set, the position uncertainty is widened to ~500 km (an
object can move that far in 4 h) rather than disabling pruning entirely; that
still drops the antipodal half of the constellation. Aim for a whole window in
one or two 1024 B Block2 blocks (~13 SVs per block).

A device that sets `all` bypasses this: the server returns every SV in the
window (no `PruneBundle`), regardless of any resolved position. This trades
payload size for coverage and is intended for cold starts with no trusted
position, or for debugging. Pruning otherwise remains the default.
