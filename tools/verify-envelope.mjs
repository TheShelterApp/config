#!/usr/bin/env node
// Verify ONE signed config envelope ({payload, sig, kid}) against the PUBLIC keys every client embeds, and check its
// doc/env binding. Dependency-free on purpose (node:crypto only) so CI can run it before trusting anything else.
// Freshness is NOT checked: the scheduled refresh must be able to rescue an expired document.
//
//   node tools/verify-envelope.mjs <file> --doc <bundle|alerts-policy|ios-config|…> --env <dev|staging|prod>
//        [--kid <expected kid>] [--print git-sha|version|kid]
//
// TRUSTED is the config trust set per env (platform contract C6, packages/domain/src/keyring.ts). Update it together
// with the platform keyring, the iOS EmbeddedKeys and PINNED_VERIFY_MJS in .github/workflows/publish.yml (CI does
// not run this file — it uses that pinned copy) — never trust a kid here before the clients do.
// FOLLOW-UP at owner step O-4: once the first cfg-2026d prod publish has landed, drop cfg-2026a from TRUSTED.prod
// here and in the workflow's pinned verifier (cfg-2026a is readable by the unreviewed dev/staging jobs).
import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const C6 = {
  'cfg-2026a': 'JFJqkUuyDkKVkZupAwfSRc+X2Nn82I3kkSxsxlApyJA=',
  'cfg-2026e': '7Fv27oGtbWUGmjFQCMiyJvHU3DKH+E+QPtb0Kxz8O+8=',
  'cfg-2026d': 'W23ii85cHhsNpK/n9Z50ANHYHtpMJ0L0RjEFXx3q9vE=',
}
const TRUSTED = { dev: C6, staging: C6, prod: C6 }

const fail = (msg) => {
  console.error(`verify-envelope: ${msg}`)
  process.exit(1)
}
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const [file] = args
const doc = opt('doc')
const env = opt('env')
const expectKid = opt('kid')
const print = opt('print')
if (!file || file.startsWith('--') || !doc || !env) fail('usage: verify-envelope.mjs <file> --doc <doc> --env <dev|staging|prod> [--kid <kid>] [--print git-sha|version|kid]')
const keys = TRUSTED[env]
if (!keys) fail(`unknown env ${env}`)

let envelope
try {
  envelope = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  fail(`${file} is not readable JSON (${e.message})`)
}
const b64 = keys[envelope.kid]
if (!b64) fail(`${file} is signed by kid ${envelope.kid}, which ${env} does not trust (${Object.keys(keys).join(', ')})`)
if (expectKid && envelope.kid !== expectKid) fail(`${file} is signed by kid ${envelope.kid}, expected ${expectKid} (CONFIG_KID and the CONFIG_ED25519_PRIVATE secret must name the same key)`)
const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')])
const payload = Buffer.from(String(envelope.payload), 'base64')
if (!verify(null, payload, { key: spki, format: 'der', type: 'spki' }, Buffer.from(String(envelope.sig), 'base64'))) fail(`${file}: the signature does NOT verify under ${envelope.kid}`)
let body
try {
  body = JSON.parse(payload.toString('utf8'))
} catch (e) {
  fail(`${file}: the signed payload is not JSON (${e.message})`)
}
if (body.doc !== doc || body.env !== env) fail(`${file} is ${body.doc}/${body.env}, expected ${doc}/${env}`)
if (print === 'git-sha') {
  if (!/^[0-9a-f]{40}$/.test(String(body.gitSha)) || /^0+$/.test(body.gitSha)) fail(`${file} carries no usable gitSha`)
  console.log(body.gitSha)
} else if (print === 'version') {
  console.log(body.version)
} else if (print === 'kid') {
  console.log(envelope.kid)
} else if (print !== undefined) {
  fail(`unknown --print ${print}`)
}
