# TheShelterApp/config

The signed configuration plane for The Shelter. `docs/*.json` are the **only** hand-edited files —
the five documents (ios-config, origins, alert-thresholds, features, kill-switches). On push, CI
validates them and signs them into `published/<env>/v1/{bundle,<doc>}.json` (an Ed25519
`{payload, sig, kid}` envelope over the RFC 8785 canonical bytes). Clients verify with the compiled-in
`cfg-2026a` public key; the server never re-signs.

- Branch → env: `dev` → dev, `staging` → staging, `main` → prod (1 reviewer).
- Version = the branch commit count (monotonic; `config-tool` refuses a version ≤ the published one).
- `tools/config-tool.mjs` is the bundled signer (from theshelter platform `@shelter/config-tool`);
  regenerate it with `pnpm exec esbuild packages/config-tool/src/cli.ts --bundle --format=esm
  --platform=node --outfile=tools/config-tool.mjs` in the platform repo.

## Local use

```sh
node tools/config-tool.mjs validate docs/
CONFIG_ED25519_PRIVATE="$(cat key.pem)" node tools/config-tool.mjs seal docs/ --env dev --version 1 --kid cfg-2026a --out published/dev/v1/
node tools/config-tool.mjs keygen cfg-2026a   # prints { kid, privatePkcs8Pem, publicKeyBase64 }
```

Edit values in `docs/` (origins ladder, alert bands, feature flags, `kill-switches.min_supported_build`)
before the first prod publish. Never commit a private key.
