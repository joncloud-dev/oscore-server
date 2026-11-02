# iotcore Extension SDK (public)

Everything a customer needs to build a product on the closed-source **iotcore**
IoT server, without any access to its Go source. This directory is what gets
published to the **public** companion repository (see `../docs/REPO-SPLIT.md`); the
Go module stays private.

Contents:

- `types/iot.d.ts` — TypeScript declarations for the `$iot` global available in
  `pb_hooks` and `pb_migrations`. Pair it with the PocketBase-generated
  `pb_data/types.d.ts` for full editor autocomplete.
- `schemas/device_profile.schema.json` — JSON Schema for a `device_profiles`
  record (wire keys, metric registry, public view, platform selection).
- `protocol/` — the device wire contract for firmware authors:
  [`README.md`](protocol/README.md) (resources, keys, response codes,
  versioning and compatibility rules) and [`device.cddl`](protocol/device.cddl)
  (RFC 8610 CDDL for every CBOR message).
- `../examples/water-temp/` — a complete example product (profile + hooks +
  static page) that reproduces a real deployment with zero Go changes.

## The extension surface

You extend the running binary with, and only with:

| Mechanism            | What you can do                                         |
|----------------------|---------------------------------------------------------|
| `pb_hooks/*.pb.js`   | custom HTTP routes, record hooks, cron, `$http`, `$iot` |
| `pb_migrations/*.js` | your own collections and schema                         |
| `device_profiles`    | wire-key mapping, metric registry, public view, platform |
| `pb_public` / `PB_UI_DIR` | static site + dashboard overrides                  |

Licensed under MIT (see `LICENSE`); your extensions are yours.
