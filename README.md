# TheShelterApp/config

The signed configuration plane for The Shelter. `docs/*.json` are the **only** hand-edited files —
the five bundle documents (ios-config, origins, alert-thresholds, features, kill-switches) plus the
standalone **alerts-policy** (`docs/alerts-policy.json`). On push, CI validates them and signs the bundle
into `published/<env>/v1/{bundle,<doc>}.json` and the alerts-policy into `published/<env>/v1/alerts/policy.json`
(each an Ed25519 `{payload, sig, kid}` envelope over the RFC 8785 canonical bytes). Clients verify with their
compiled-in public keys; the servers never re-sign.

`alerts-policy` is **separate from the bundle**: it is a single signed doc the alerts-gateway reads from the
**data bucket** at `shelter-data-<env>/alerts/policy.json` (not `config.theshelter.app`). Its body is
validated against the gateway's `alertPolicySchema` at seal time. Until it is uploaded to the data bucket,
the gateway runs the restrictive compiled fallback (tier-2 off).

- Branch → env: `dev` → dev, `staging` → staging, `main` → prod (the `prod` environment needs 1 reviewer).
  The default branch is `main`. Edits go `dev` → `staging` → `main`; never rewrite the history of those branches.
- Version = the branch commit count (monotonic; consumers treat a lower version as a rollback).
- Freshness: the scheduled `refresh` (Mon/Thu 05:23 UTC, from `main`) re-seals the LAST PUBLISHED content of every
  env (never an unapproved push) so nothing expires (bundle 30 d, policy 90 d).

## Where a publish lands

After the mirror commit is pushed, both `publish` and `refresh` upload (with `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`, environment secrets):

| what | where | read by |
|---|---|---|
| `alerts/policy.json` | R2 `shelter-data-<env>/alerts/policy.json` | alerts-gateway |
| each of the 6 bundle files | R2 `shelter-config-<env>/v1/<doc>.json` + immutable `v1/history/<doc>/<version>.json` | config Worker (durable source) |
| each of the 6 bundle files | KV `v1:<doc>` with metadata `{version, kid}` in the env's `shelter-config` namespace | config Worker (hot source) |
| `bundle.json` | R2 `shelter-data-<env>/config/v1/bundle.json`, `cache-control: public, max-age=300` | the app, first (then the config host) |
| the mirror | `published/<env>/v1/` in this repo (raw.githubusercontent) | config Worker (last fallback) |

`node tools/config-tool.mjs publish published/<env>/v1/ --env <env> --r2 --then-kv --data-copy` does the bundle
part: it first verifies all six files (signature under a trusted kid, doc/env binding, fresh, one version + one
kid), then runs the pinned `wrangler@4.136.0` (`r2 object put … --remote`, `kv key put … --metadata … --remote`) in
the order R2 → KV → public copy. Add `--dry-run` to verify and print the plan without uploading. Re-running it is
idempotent.

## Keys (never commit a private key)

| kid | role | where the private half lives |
|---|---|---|
| `cfg-2026a` | dev/staging signer (and prod until the switch) | repo-level secret `CONFIG_ED25519_PRIVATE` |
| `cfg-2026c` | prod signer after the switch | `prod` + `prod-refresh` environment secret `CONFIG_ED25519_PRIVATE`, variable `CONFIG_KID=cfg-2026c` |
| `cfg-2026b` | offline standby | offline only — never uploaded until a rotation |

The workflow signs with `--kid ${{ vars.CONFIG_KID || 'cfg-2026a' }}`. Every consumer — the platform keyring
(`packages/domain/src/keyring.ts`), the iOS `EmbeddedKeys`, and `tools/verify-envelope.mjs` here — must trust a kid
BEFORE anything signs with it. Before each mirror push, CI self-checks the freshly sealed bundle and policy with
`tools/verify-envelope.mjs` (kid must equal `CONFIG_KID` and verify) and `config-tool publish --dry-run`, so a secret
that does not match `CONFIG_KID` fails the job instead of reaching devices. The `refresh` trust check accepts a
published bundle signed by any kid of the env's trusted set.

## The bundled tool

`tools/config-tool.mjs` is the bundled signer/publisher (from the platform repo's `@shelter/config-tool`).
Regenerate it from the platform repo root (esbuild is a transitive dependency there, reachable through pnpm's
hidden hoist):

```sh
node_modules/.pnpm/node_modules/.bin/esbuild packages/config-tool/src/cli.ts --bundle --format=esm \
  --platform=node --outfile=../config/tools/config-tool.mjs
```

then run `node tools/config-tool.mjs validate docs/` here. A schema change in the platform (a field added or
retired) lands here together with the doc edit it requires, in one commit, so every commit validates.
`tools/verify-envelope.mjs` is hand-written and dependency-free (node:crypto only).

## Local use

```sh
node tools/config-tool.mjs validate docs/
CONFIG_ED25519_PRIVATE="$(cat key.pem)" node tools/config-tool.mjs seal docs/ --env dev --version 1 --kid cfg-2026a --out published/dev/v1/
CONFIG_ED25519_PRIVATE="$(cat key.pem)" node tools/config-tool.mjs seal-policy docs/alerts-policy.json --env dev --version 1 --kid cfg-2026a --out published/dev/v1/
node tools/verify-envelope.mjs published/dev/v1/bundle.json --doc bundle --env dev --print version
node tools/config-tool.mjs publish published/dev/v1/ --env dev --r2 --then-kv --data-copy --dry-run
node tools/config-tool.mjs keygen cfg-2027a   # prints { kid, privatePkcs8Pem, publicKeyBase64 } — run it offline
```

## Document notes

- `kill-switches`: `push_alerts` / `live_activities` were retired (platform plan D-17) — the signed alerts policy's
  `killSwitches.fanout` / `killSwitches.liveActivities` are the push authority. `notice` is `null` or
  `{ id, severity: info|warning, title: {en, ru?}, body: {en, ru?}, url?, until_epoch_sec? }`;
  `min_supported_build.ios` is a CFBundleVersion floor (the app's build number is the git commit count).
- `ios-config.regions_db`: `{ version, url, size_bytes, sha256 }` of the offline region-tiles bundle (copy the
  values from `region-tiles/regions-db.json`; `size_bytes`/`sha256` are of the `.gz`, sha256 lowercase hex).
- `alerts-policy`: tiers use the `default` sound (no custom sound ships).
