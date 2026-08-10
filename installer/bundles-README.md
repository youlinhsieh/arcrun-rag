# Arcrun RAG — install bundles

Prebuilt Cloudflare Worker bundles for the **[Arcrun RAG](https://github.com/youlinhsieh/arcrun-rag)**
one-click installer. The installer fetches them automatically — you never need to clone or read this repo by hand.

## `manifest.json` is the index — read that, not this file

Everything that changes between releases lives in **[`manifest.json`](manifest.json)**, so it cannot go stale:

| field | what it tells you |
|---|---|
| `release` | the bundle release these artifacts belong to |
| `source` | the exact `Arcrun@<commit>` the workers were built from |
| `built` | build date |
| `core[]` | one entry per shipped worker — file path, `sha256`, compat date/flags, and the KV / D1 / vars bindings that worker needs |
| `daemon` | desktop app version, plus its download files and their `sha256` |
| `promoted_from` | which verified build this release was promoted from |

Counts, versions and file names are deliberately **not** repeated here. `manifest.json` is generated from the
artifacts themselves; this file is hand-written, so anything copied into it would drift out of date.

## Layout

- `<worker-name>/` — one directory per Worker: `worker.mjs`, plus any `.wasm` module it loads.
- `tier2/<name>/index.js` — components that ship as a single prebuilt JS file (e.g. the Portal front end).
- `daemon/` — desktop app installers referenced by `manifest.daemon`.

The set of directories follows `manifest.core` — if the two disagree, `manifest.core` is correct.

## How it is produced

Built and published by the ship pipeline in the
[arcrun-rag](https://github.com/youlinhsieh/arcrun-rag) repo. A release is promoted from an
already-verified build rather than rebuilt, and the promotion is recorded in `manifest.promoted_from`.

Do not hand-edit artifacts in this repo. The installer compares each worker's `sha256` against what it last
deployed to decide which workers actually need redeploying, so edited files silently change that decision.
