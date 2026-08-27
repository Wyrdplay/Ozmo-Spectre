/**
 * Refuse to publish a commit that carries a credential.
 *
 * This runs as the FIRST step of CI, before anything expensive, because since
 * publish-on-green landed there is no longer a human between a commit and a
 * public repository. GitHub's own push protection covers Ozmo-Spectre, but it
 * only recognises well-known provider tokens — it would not blink at a
 * TeamCity admin password in a .txt file, and it is not enabled on the private
 * repos at all. This covers the gap in both directions.
 *
 * Two passes:
 *   1. FILENAMES that should never be tracked, whatever is inside them.
 *   2. CONTENT patterns — provider tokens, private keys, and generic
 *      credential assignments with a real-looking value.
 *
 * Scans tracked files only (git ls-files), so ignored build output and
 * node_modules cost nothing.
 *
 * Usage:  node scripts/scan-secrets.mjs [--staged]
 * Exit:   0 clean, 1 findings.
 */
import { execFileSync } from 'child_process'
import fs from 'fs'

const STAGED = process.argv.includes('--staged')

/** Filenames that are a finding by existing, regardless of content. */
const BAD_NAMES = [
  /(^|\/)\.env($|\.(?!example|sample|template|dist|md)[^/]*$)/i,
  /(^|\/)[^/]*credential[^/]*\.(txt|json|ya?ml|ini|cfg|conf)$/i,
  /(^|\/)[^/]*secret[s]?\.(txt|json|ya?ml|ini|cfg|conf)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|pfx|p12|keystore|jks)$/i,
  /(^|\/)p4tickets\.txt$/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/
]

/**
 * Content patterns. Each needs a plausible VALUE, not just a keyword — this
 * repo legitimately contains the words token, secret and password in prose
 * (llms.txt documents a "Session Tokens" example and a markdown tokenizer),
 * and a scanner that cries wolf gets switched off.
 */
const PATTERNS = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'credential assignment',
    // key = "value" where the value looks like a real secret, not a placeholder
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"'{}<>$#,;]{12,})["']?/i,
    check: (m) => {
      const v = m[1]
      if (/^(?:your|my|the|a|an|some|example|sample|placeholder|redacted|hidden|changeme|xxx+|\*+|\.{3,})/i.test(v)) return false
      if (/^\$\{?[A-Z_]+\}?$/.test(v)) return false      // ${ENV_VAR}
      if (/^%[a-z.]+%$/i.test(v)) return false            // %teamcity.param%
      if (/^<[^>]+>$/.test(v)) return false               // <placeholder>
      if (/^(?:true|false|null|undefined|none)$/i.test(v)) return false
      // a code reference, not a literal: accessToken = tokenJson.access_token
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false
      if (/^[A-Za-z_$][\w$]*$/.test(v)) return false
      if (/^(?:await|new|function|return|require|import)/.test(v)) return false
      if (!/[0-9]/.test(v) && !/[^a-zA-Z]/.test(v) && v.length < 20) return false // a plain word
      return true
    }
  }
]

const SKIP_CONTENT = [/(^|\/)node_modules\//, /\.d\.ts$/, /(^|\/)package-lock\.json$/, /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|woff2?|ttf|otf|db)$/i]

function tracked() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files']
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
}

const findings = []
for (const f of tracked()) {
  if (/(^|\/)node_modules\//.test(f)) continue
  for (const re of BAD_NAMES) {
    if (re.test(f)) findings.push({ file: f, line: 0, what: 'a file that should never be tracked' })
  }
  if (SKIP_CONTENT.some((re) => re.test(f))) continue
  let text
  try {
    const buf = fs.readFileSync(f)
    if (buf.includes(0)) continue                 // binary
    if (buf.length > 2_000_000) continue
    text = buf.toString('utf8')
  } catch { continue }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/scan-secrets/.test(f) && /re:\s*\//.test(line)) continue   // this file's own patterns
    if (/\bsecret-scan-ignore\b/.test(line)) continue                // deliberate opt-out, greppable
    for (const p of PATTERNS) {
      const m = p.re.exec(line)
      if (!m) continue
      if (p.check && !p.check(m)) continue
      findings.push({ file: f, line: i + 1, what: p.name })
    }
  }
}

if (findings.length === 0) {
  console.log(`[scan-secrets] clean — ${tracked().length} tracked files, no credentials found`)
  process.exit(0)
}

console.error(`[scan-secrets] ${findings.length} finding(s) — refusing to let this reach a remote:\n`)
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.what}`)
}
console.error(`
Nothing has been published. Fix by removing the credential and rotating it —
assume anything committed is already compromised, even before a push.
A false positive can be silenced with a "secret-scan-ignore" comment on the
line, which stays greppable so the exemption is auditable.
`)
process.exit(1)
