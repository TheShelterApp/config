# TheShelterApp/config

The signed configuration plane for The Shelter. `docs/*.json` are the **only** hand-edited files —
the five bundle documents (ios-config, origins, alert-thresholds, features, kill-switches) plus the
standalone **alerts-policy** (`docs/alerts-policy.json`). On push, CI validates them and signs the bundle
into `published/<env>/v1/{bundle,<doc>}.json` and the alerts-policy into `published/<env>/v1/alerts/policy.json`
(each an Ed25519 `{payload, sig, kid}` envelope over the RFC 8785 canonical bytes). Clients verify with the
compiled-in `cfg-2026a` public key; the server never re-signs.

`alerts-policy` is **separate from the bundle**: it is a single signed doc the alerts-gateway reads from the
**data bucket** at `shelter-data-<env>/alerts/policy.json` (not `config.theshelter.app`). Its body is
validated against the gateway's `alertPolicySchema` at seal time. Until it is uploaded to the data bucket,
the gateway runs the restrictive compiled fallback (tier-2 off).

- Branch → env: `dev` → dev, `staging` → staging, `main` → prod (1 reviewer).
- Version = the branch commit count (monotonic; `config-tool` refuses a version ≤ the published one).
- `tools/config-tool.mjs` is the bundled signer (from theshelter platform `@shelter/config-tool`);
  regenerate it with `pnpm exec esbuild packages/config-tool/src/cli.ts --bundle --format=esm
  --platform=node --outfile=tools/config-tool.mjs` in the platform repo.

## Local use

```sh
node tools/config-tool.mjs validate docs/
CONFIG_ED25519_PRIVATE="$(cat key.pem)" node tools/config-tool.mjs seal docs/ --env dev --version 1 --kid cfg-2026a --out published/dev/v1/
# alerts-policy is sealed on its own (standalone doc → data bucket), then uploaded to shelter-data-<env>:
CONFIG_ED25519_PRIVATE="$(cat key.pem)" node tools/config-tool.mjs seal-policy docs/alerts-policy.json --env dev --version 1 --kid cfg-2026a --out published/dev/v1/
# XDG_CONFIG_HOME=~/.config/shelter-cf wrangler r2 object put shelter-data-dev/alerts/policy.json --file published/dev/v1/alerts/policy.json --remote
node tools/config-tool.mjs keygen cfg-2026a   # prints { kid, privatePkcs8Pem, publicKeyBase64 }
```

Edit values in `docs/` (origins ladder, alert bands, feature flags, `kill-switches.min_supported_build`)
before the first prod publish. Never commit a private key.
