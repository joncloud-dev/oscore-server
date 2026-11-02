# Repository split: private core, public distribution, product repos

The product is distributed as a **closed-source binary + Docker image**. To keep
the Go source private while still giving customers everything they need to build
on top of it, the code lives in three kinds of repositories:

| Repo | Visibility | Holds |
|---|---|---|
| `github.com/joncloud-dev/joncloud` | private | the Go source + release tooling (this one) |
| `github.com/joncloud-dev/oscore-server` | public | release binaries (GitHub Releases), deploy docs, SDK, small examples |
| `github.com/joncloud-dev/water-temp` (and any other product) | public or customer-owned | one product on the extension layer, run against a pinned released image |

## Private repository (this one)

Contains the full Go module and the build/release tooling. Never made public.

```
go/
  cmd/ internal/ migrations/     # the closed core
  Dockerfile entrypoint.sh
  .goreleaser.yaml                # run by the repo-root .github/workflows/release.yml
  scripts/gen-third-party-notices.sh
  LICENSE (Binary License)  THIRD_PARTY_NOTICES.txt
  sdk/  examples/                 # mirrored to the public repo (see below)
docs/                             # design docs; REPO-SPLIT.md is mirrored too
```

Only build artifacts are published from here, and they land in the public repo:
a `v*` tag runs `.github/workflows/release.yml`, and goreleaser creates the
GitHub Release on `joncloud-dev/oscore-server` (token secret
`OSCORE_SERVER_RELEASE_TOKEN`) and pushes `ghcr.io/joncloud-dev/oscore-server`.
The source stays private.

## Public distribution repository (`oscore-server`)

The landing page for the released binary plus the extension-layer materials. No
Go source; binaries are never committed, only attached to its Releases:

```
README.md                         # from go/public-repo/README.md
DEPLOY.md                         # from go/DEPLOY.md
sdk/types/iot.d.ts                # $iot type declarations
sdk/schemas/device_profile.schema.json
sdk/protocol/                     # device wire contract: README.md + device.cddl
examples/                         # small extension examples (not water-temp)
docs/                             # extension API docs + agnss-schema.md
LICENSE                           # MIT (LICENSE-EXTENSIONS), for the repo contents
LICENSE-BINARY.txt                # Binary License (go/LICENSE), for the released binary
THIRD_PARTY_NOTICES.txt
```

Generate/refresh its contents from this repo (run from `go/`), then commit
there. Do this before tagging so the release's landing page matches it:

```sh
./scripts/sync-public-sdk.sh ../../oscore-server
```

## Product repositories (e.g. `water-temp`)

A product is only `pb_hooks/`, `pb_migrations/`, `pb_public/` and a
`docker-compose.yml` that runs a **pinned** `ghcr.io/joncloud-dev/oscore-server`
version with those folders mounted. It never needs this repo. `go/examples/water-temp/`
stays here as the in-archive reference copy; the standalone repo is the one to
develop the product in.

## Why this shape

- The Go implementation (OSCORE engine, platform decoders, state machines) is
  the proprietary value and never leaves the private repo.
- The extension contract (`$iot`, profile schema, hook examples) is public and
  permissively licensed, so customers can freely write and share hooks and
  profiles.
- Adding a new **platform** (silicon family) is a private-repo change (a new
  `plat.Spec`); adding a new **product** is entirely a
  public-repo / extension change with no core rebuild.
