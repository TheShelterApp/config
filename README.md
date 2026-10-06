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
{cfg-2026a, cfg-2026d, cfg-2026e} for dev and staging and {cfg-2026d, cfg-2026e} for prod (re-keyed 2026-09-26:
cfg-2026b/c were lost with an unopenable encrypted volume before they signed anything and are no longer trusted).

**Done at owner step O-4 (2026-09-26):** prod signs with `cfg-2026d` from v31; `cfg-2026a` is no longer trusted for
prod anywhere (pinned verifier, `tools/verify-envelope.mjs`, platform keyring, config Worker, iOS prod builds).

**Open (CFG-9, owner):** `cfg-2026a` is still a REPOSITORY-level secret, and the `dev` and `staging` environments have
no deployment branch policy, so a workflow on any branch of this repo can read the dev/staging signing key. The fix
is GitHub settings only (no code change; the workflow already reads `secrets.CONFIG_ED25519_PRIVATE`, and an
environment secret takes precedence over a repository secret of the same name):

1. Settings → Environments → `dev` → Environment secrets → Add: `CONFIG_ED25519_PRIVATE` = the cfg-2026a PKCS#8 PEM
   (Apple Passwords). Same for `staging`. (`CONFIG_KID` needs no variable there: the default is `cfg-2026a`.)
2. Settings → Environments → `dev` → Deployment branches and tags → Selected branches and tags → add `dev` and
   `main`. `staging`: add `staging` and `main`. `main` is needed because the scheduled `refresh` and
   `refresh-upload` run their dev and staging legs from `main` (GitHub runs schedules only from the default branch);
   without it every refresh of dev and staging is refused and their bundles expire in 30 days.
3. Prove both paths: Actions → config → Run workflow (branch `main`) — the refresh and refresh-upload legs of all three
   envs are green; then any push to `dev` (e.g. the next doc edit) — publish and publish-upload are green.
4. Settings → Secrets and variables → Actions → Repository secrets → remove `CONFIG_ED25519_PRIVATE`. Until this step
   the repository-level copy stays readable from any branch, so the finding stays open. (If step 3 fails, the
   repository copy is still there to fall back to: put back the branch policies' previous state, investigate.)
5. Optional: the same environment-only treatment for `CONFIG_KID` if a repository variable exists (it is not secret).

Sources (accessed 2026-10-06): an environment secret wins over a repository secret of the same name
(https://docs.github.com/en/actions/reference/security/secrets); a deployment branch rule is matched against the
workflow run's `GITHUB_REF`, which for `schedule` is the default branch
(https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments,
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

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
  `news_disabled` / `videos_disabled` (optional booleans, absent = `false`; platform decision D-25) are the per-feed
  kill switches: `true` hides the News or the Videos feed in the app while every other feed keeps working. Builds
  that predate them ignore the keys (the app decodes this doc with a keyed container).
- `ios-config.regions_db`: `{ version, url, size_bytes, sha256 }` of the offline region-tiles bundle (copy the
  values from `region-tiles/regions-db.json`; `size_bytes`/`sha256` are of the `.gz`, sha256 lowercase hex).
- `ios-config.videos` (optional): the Videos tab's channel list. The app itself reads each channel's public YouTube
  RSS, so editing this changes every installed app's Videos list without a release.
  `{ channels: [{ id, title, lang, iconURL? }], windowDays?, maxItems? }`: `id` is the `UC…` channel id (`UC` + 22
  characters of `[A-Za-z0-9_-]`, the key of `youtube.com/feeds/videos.xml?channel_id=…`), 1–50 channels with unique
  ids; `title` is 1–100 characters (shown only when a feed names no channel); `lang` is two lowercase letters
  (ISO 639-1); `iconURL` (optional, https, ≤ 512 characters) is the channel avatar — the `og:image` of
  `m.youtube.com/channel/<id>`, read once when the channel is curated — with which the app never scrapes the channel
  page for the avatar (without it the app reads the page, then falls back to the channel's initials; a stale URL
  falls back the same way, so refresh it here when YouTube changes it). `windowDays` 1–30 (the app defaults to 7;
  this doc sets 14 since 2026-10-01, owner decision) is how long an upload stays in the list, and the list's end
  line names it ("No more 14-day videos"; builds before 274 ignore the field and keep 7). `maxItems` 1–200 (the app
  defaults to 60) caps the list. A device picks up a new bundle within a config poll (`poll.configIntervalSeconds`,
  900 s); a changed channel set then makes its next
  Videos load refresh at once instead of waiting out the 30-minute pause. Without the field the app uses its compiled
  list (builds up to 467: the 14 channels this doc carried on 2026-09-27; from build 476 (iOS pr12/videos) on: the
  26 English channels it carried on 2026-09-30, without DW News and the two Russian channels); older builds ignore
  the key. The schema is `packages/domain/src/config/ios-config.ts` in the platform repo.
  Curation rule (owner, 2026-09-30): official seismology / geology / tsunami institutions, wire services and
  established public or national broadcasters; no pop-science, no clickbait, no state-propaganda outlets and no
  organisation Russia lists as "undesirable" (DW since 2025-12, RFE/RL since 2024-02). Exception (owner,
  2026-10-01): DW News is listed again, the owner accepting the risk of Deutsche Welle's "undesirable" status in
  Russia. Re-check the register (the Ministry of Justice list; its ru.wikipedia mirror) for every other channel
  before adding it. Before adding a channel, also check that its RSS has uploads within the last 60 days and that
  its titles are English or Russian: the app shows only the
  uploads whose TITLE passes its earthquake keyword filter (English + Russian patterns, `VideoFeedLogic.swift`; the
  description lead is read only for the channel ids compiled into its `scienceChannelIDs`, without the institutions'
  own names). `lang`: builds from 476 (iOS pr12/videos) on show a channel only when its `lang` is `en` or the app's
  language (English channels reach everyone, Russian ones only the Russian app); builds 467 and older ignore `lang`
  and show every listed channel to every user, so a Russian channel shows its (earthquake) Russian titles in the
  English app too. The owner listed BBC News Russian and Euronews in Russian on 2026-10-01 knowing that testers
  may still run such a build.
- `alerts-policy`: tiers use the `default` sound (no custom sound ships).
- `features` (CFG-2): every flag is RESERVED — nothing reads `community_reports_v2`, `apple_sign_in` or
  `region_overlay`, and the app has no screen that calls its flag accessor. Keep the `flags` map and `auth`: every iOS
  build to date (437–581 and iOS main, as of 2026-10-06) decodes both as required, and a bundle without either fails
  to decode on every one of them (they keep their last good config, kill switches included). Either can go only after
  a build that decodes it leniently has become the `kill-switches.min_supported_build.ios` floor. `region_overlay` is
  `false` while the app draws the overlay unconditionally: set it to `enabled: true, rollout: 100` before any build
  starts reading it. A new flag does nothing until a client that reads it ships.

## Who reads each knob (CFG-8, as of 2026-10-06)

**iOS** = the app (builds 437–581 and iOS main as of 2026-10-06; "≥ N" is the first build that reads it), **api** =
the api Worker, **gateway** = the alerts-gateway, **validate** = a rule `config-tool validate` / `seal-policy` checks
before signing. **Informational** = signed and served but read by nothing at run time: editing it changes no
behaviour. **Reserved** = meant for a consumer that is not built yet. The config Worker serves every document and reads
none of its fields. Every field stays while a build in use decodes it as required. The same table, with references,
is in the platform spec `docs/tdd/specs/platform-ports-config.md` ("Who reads each signed knob").

| Document · knob | Read by |
|---|---|
| ios-config · `ios_data_source` | iOS (the data-source override) |
| ios-config · `feed_disabled` | iOS (builds < 532 read only this copy); validate: equals `kill-switches.feed_disabled` (CFG-1) |
| ios-config · `poll.configIntervalSeconds`, `poll.jitterFraction` | iOS (config poll cadence, at least 60 s) |
| ios-config · `poll.manifestIntervalSeconds` | informational |
| ios-config · `api.*` | informational (each build has its env's api host compiled in) |
| ios-config · `data.base` | iOS (Stories and the community map) |
| ios-config · `data.manifestPath`, `data.statusPath` | informational |
| ios-config · `staleness.*` | informational (freshness comes from the feed's status.json); validate: stale > delayed |
| ios-config · `reports.*` | informational (compiled in the app and the api); validate: `coarseningCellMeters` = 1000 |
| ios-config · `tiles.*` | informational (superseded by `regions_db`) |
| ios-config · `regions_db`, `videos` | iOS |
| origins · `ladder`, `backoff` | informational (read only by the OriginLadder module, which the app does not use) |
| origins · `directOrigins.enabled`, `.minIntervalSeconds`, `.jitterFraction` | iOS ≥ 532 |
| origins · `directOrigins.providers` | informational (URLs are compiled); validate: each name is in the allowlist |
| alert-thresholds · all | informational; validate: bands ascending |
| features · `flags.*` | reserved (above) |
| features · `auth.providers` | informational |
| kill-switches · `feed_disabled` | iOS ≥ 532 (the authority) |
| kill-switches · `news_disabled`, `videos_disabled`, `usgs_submit`, `min_supported_build.ios`, `notice` | iOS |
| kill-switches · `community_write_mode` | iOS and api (the server write gate) |
| kill-switches · `direct_origins_provider_allowlist` | iOS ≥ 532; validate |
| kill-switches · `min_supported_build.watchos` | informational (the Watch app reads no config) |
| kill-switches · `push_alerts`, `live_activities` | retired, read by nothing; kept for pre-round-3 builds |
| alerts-policy · `globalMinMag`, `maxAlertAgeSec`, `radiusByMagnitude`, `cellMarginKm`, `tiers`, `quietHoursOverrides`, `revision` | gateway; validate (ranges, order) |
| alerts-policy · `liveActivity.maxUpdatesPerActivity`, `.endAfterQuietSec`, `.maxLifetimeSec`, `.staleAfterSec`, `.aftershockRadiusKm` | gateway |
| alerts-policy · `liveActivity.minOs`, `fanout.*`, `apns.activeKid`, `apns.topic` | informational (the gateway uses compiled page sizes and its own `APNS_KEY_ID` / `APNS_TOPIC`); validate: apns formats |
| alerts-policy · `killSwitches.*`, `flags.broadcastChannels` | gateway |
| alerts-policy · `flags.testPush`, `flags.watchStandalone`, `flags.criticalAlerts` | reserved (no test-alert route, standalone Watch registration or critical upgrade is built) |
