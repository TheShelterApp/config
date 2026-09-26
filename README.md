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

## CI jobs (`.github/workflows/publish.yml`)

| job | trigger | runs | holds |
|---|---|---|---|
| `publish` | push to dev/staging/main | git, the workflow-pinned verifier, the PUSHED commit's tool | signing key (one step: seal/seal-policy only), push credential (the `git push` only) |
| `publish-upload` | after `publish` | the branch tip's `tools/config-tool.mjs publish`, `npx wrangler` | `CLOUDFLARE_API_TOKEN` (read-only GITHUB_TOKEN) |
| `refresh` | Mon/Thu 05:23 UTC, dispatch | git, the workflow-pinned verifier, the PUBLISHED commit's tool — no branch-tip code | signing key (one step: seal/seal-policy only), push credential (the `git push` only) |
| `refresh-upload` | after `refresh` | like `publish-upload`, per env | like `publish-upload` |

- Branch-tip code and `npx wrangler` (unpinned dependency tree) run only in the upload jobs, which never see the
  signing key and cannot push. The prod upload jobs run in `prod-refresh` (no second approval).
- The refresh locates "the last published content" with the verifier pinned in the workflow file
  (`PINNED_VERIFY_MJS`), not with `tools/verify-envelope.mjs` from the checkout.
- Both seal jobs refuse a version (the branch commit count) that is not above the version the mirror holds (a
  rewritten history), and never re-seal after a rejected push: a refresh that lost a race to a publish is dropped;
  a publish that lost a race to a refresh fails with "re-run this job"; when the commit that landed touches none of
  docs/, tools/, published/, the one mirror commit is replayed on top of it.
- Uploads run one at a time per env (concurrency group `config-upload-<env>`) and always upload the branch TIP's
  mirror; `config-tool publish` first reads the live versions and never overwrites a newer one.

## Where a publish lands

After the mirror commit is pushed, the upload jobs run (with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`,
environment secrets):

| what | where | read by |
|---|---|---|
| `alerts/policy.json` | R2 `shelter-data-<env>/alerts/policy.json` | alerts-gateway |
| each of the 6 bundle files | R2 `shelter-config-<env>/v1/<doc>.json` + immutable `v1/history/<doc>/<version>.json` | config Worker (durable source) |
| each of the 6 bundle files | KV `v1:<doc>` with metadata `{version, kid}` in the env's `shelter-config` namespace | config Worker (hot source) |
| `bundle.json` | R2 `shelter-data-<env>/config/v1/bundle.json`, `cache-control: public, max-age=300` | the app, first (then the config host) |
| the mirror | `published/<env>/v1/` in this repo (raw.githubusercontent) | config Worker (last fallback) |

`node tools/config-tool.mjs publish published/<env>/v1/ --env <env> --policy --r2 --then-kv --data-copy` does all
of it: it first verifies the policy and all six bundle files (signature under a trusted kid, doc/env binding, fresh,
one version + one kid), then reads what is live (`wrangler r2 object get … --remote --pipe`) and runs the pinned
`wrangler@4.136.0` (`r2 object put … --remote`, `kv key put … --metadata … --remote`) in the order policy → R2 → KV →
public copy. It skips (successfully, "live vN >= local vM") whatever is already live at the same or a newer version;
a bundle whose earlier publish of the same version stopped halfway is re-written, so re-running it heals. Add
`--dry-run` to verify and print the plan (shell-quoted, pasteable) without reading or uploading anything.

## Keys (never commit a private key)

| kid | role | where the private half lives |
|---|---|---|
| `cfg-2026a` | dev/staging signer (and prod until the switch) | repo-level secret `CONFIG_ED25519_PRIVATE` |
| `cfg-2026d` | prod signer after the switch | `prod` + `prod-refresh` environment secret `CONFIG_ED25519_PRIVATE`, variable `CONFIG_KID=cfg-2026d` |
| `cfg-2026e` | standby | the owner's Apple Passwords only — never uploaded until a rotation |

The workflow signs with `--kid ${{ vars.CONFIG_KID || 'cfg-2026a' }}`. Every consumer — the platform keyring
(`packages/domain/src/keyring.ts`), the iOS `EmbeddedKeys`, the workflow's pinned verifier (`PINNED_VERIFY_MJS` in
`.github/workflows/publish.yml`) and `tools/verify-envelope.mjs` here — must trust a kid BEFORE anything signs with
it. Before each mirror push, CI self-checks every freshly sealed file with the pinned verifier (kid must equal
`CONFIG_KID`, version the one just sealed) — and, in `publish`, with the approved tool's `publish --dry-run` — in a
step without the key, so a secret that does not match `CONFIG_KID` fails the job instead of reaching devices. The
`refresh` trust check accepts a published bundle signed by any kid of the env's trusted set: today
{cfg-2026a, cfg-2026d, cfg-2026e} for every env (re-keyed 2026-09-26: cfg-2026b/c were lost with an
unopenable encrypted volume before they signed anything and are no longer trusted).

**Follow-up at owner step O-4:** as soon as the first `cfg-2026d` prod publish has landed on `main`, remove
`cfg-2026a` from `TRUSTED.prod` in the workflow's `PINNED_VERIFY_MJS` and in `tools/verify-envelope.mjs` (one
commit, dev → staging → main). Until then the prod refresh accepts a `cfg-2026a`-signed prod mirror, and
`cfg-2026a` is readable by the unreviewed dev/staging jobs.

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
node tools/config-tool.mjs publish published/dev/v1/ --env dev --policy --r2 --then-kv --data-copy --dry-run
node tools/config-tool.mjs keygen cfg-2027a   # prints { kid, privatePkcs8Pem, publicKeyBase64 } — run it offline
```

## Document notes

- `kill-switches`: `push_alerts` / `live_activities` are retired (platform plan D-17) — the signed alerts policy's
  `killSwitches.fanout` / `killSwitches.liveActivities` are the push authority — but they STAY (`true`) for now:
  every iOS build cut before the round-3 merge decodes them as required, and a bundle without them is rejected there
  (those devices would freeze on their last-good config). `validate` prints a WARNING for them. Delete both (and the
  platform's deprecated schema fields) once no such build is installed. `notice` is `null` or
  `{ id, severity: info|warning, title: {en, ru?}, body: {en, ru?}, url?, until_epoch_sec? }`, and stays `null` for
  the same reason (pre-round-3 builds decode a different notice shape);
  `min_supported_build.ios` is a CFBundleVersion floor (the app's build number is the git commit count).
- `ios-config.regions_db`: `{ version, url, size_bytes, sha256 }` of the offline region-tiles bundle (copy the
  values from `region-tiles/regions-db.json`; `size_bytes`/`sha256` are of the `.gz`, sha256 lowercase hex).
- `alerts-policy`: tiers use the `default` sound (no custom sound ships).
