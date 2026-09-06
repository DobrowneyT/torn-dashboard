// Generates admin control-plane credentials (#609 slice 2, #646).
//
//   npx tsx db/admin-password.mts                    # print the four lines
//   npx tsx db/admin-password.mts --rotate           # rewrite deploy/.env in place
//   npx tsx db/admin-password.mts --rotate --password-only
//   npx tsx db/admin-password.mts --rotate --rotate-session
//
// Prints the four lines to paste into deploy/.env, plus a SCANNABLE QR for the
// authenticator app — typing a 32-character base32 secret by hand is the step
// that made rotation something to avoid.
//
// ⚠️ A .mts run under tsx, not a .mjs, so it imports the REAL hashing and TOTP
// code the server uses rather than a second copy. Two implementations of a
// password hash is how you end up with credentials that verify in one place and
// not the other.
//
// ⚠️ Nothing is written to disk and nothing is stored beyond the hash. The
// plaintext password is shown once, here, and cannot be recovered — re-run to
// set a new one.
import { createInterface } from 'node:readline/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readEnv, writeEnv, setEnvValues, envValue } from './adminEnvFile.mjs'
import { hashPassword } from '../server/src/adminPlane/password.js'
import { generateTotpSecret, totpUri } from '../server/src/adminPlane/totp.js'

/**
 * Read the two answers.
 *
 * ⚠️ Two paths on purpose. Interactively, readline gives real prompts. Piped,
 * readline's `question()` never SETTLES at EOF — it does not reject, it hangs —
 * and an unfinished top-level await exits Node with code 13, a stack trace, and
 * no output at all. On the step that mints the fleet's only credential that
 * reads as "the tool is broken", so the non-interactive path reads stdin
 * directly and says something useful when it is short.
 */
async function readAnswers(): Promise<{ username: string; password: string }> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const username = (await rl.question('Admin username: ')).trim()
      const password = (await rl.question('Admin password (input is visible — use a long one): ')).trim()
      return { username, password }
    } finally {
      rl.close()
    }
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  if (lines.length < 2) {
    console.error('Reading non-interactively: expected two lines on stdin (username, then password).')
    process.exit(2)
  }
  return { username: lines[0].trim(), password: lines[1].trim() }
}

const { values: args } = parseArgs({
  options: {
    rotate: { type: 'boolean' },
    'password-only': { type: 'boolean' },
    'rotate-session': { type: 'boolean' },
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '..', 'deploy', '.env')
const existing = args.rotate ? readEnv(envPath) : ''

if (args.rotate && existing === '') {
  console.error(`No ${envPath} to rotate. Run without --rotate and create it first.`)
  process.exit(2)
}
if (args['password-only'] && !args.rotate) {
  console.error('--password-only only makes sense with --rotate.')
  process.exit(2)
}

const { username, password } = await readAnswers()

if (!username) {
  console.error('Username is required.')
  process.exit(2)
}
// ⚠️ 12 is a floor, not a recommendation. This credential fronts every tenant.
if (password.length < 12) {
  console.error('Password must be at least 12 characters — this is the fleet-wide credential.')
  process.exit(2)
}

const hash = await hashPassword(password)

/**
 * ⚠️ **Keeping the existing TOTP secret is the common case, not the exotic
 * one.** A leaked password and a lost phone are different incidents; forcing
 * both to rotate together means every password change costs re-enrolling the
 * authenticator, which is exactly the friction that makes people not rotate.
 */
const keepTotp = args['password-only'] === true
const totpSecret = keepTotp
  ? (envValue(existing, 'ADMIN_TOTP_SECRET') ?? generateTotpSecret())
  : generateTotpSecret()

if (keepTotp && envValue(existing, 'ADMIN_TOTP_SECRET') === null) {
  console.error('--password-only was given but deploy/.env has no ADMIN_TOTP_SECRET to keep.')
  process.exit(2)
}

/**
 * ⚠️ **Never rotated as a side effect.** Changing ADMIN_SESSION_SECRET
 * invalidates every live admin session — correct when you mean it, baffling
 * when you did not. On a rotation the existing value is kept unless
 * --rotate-session says otherwise.
 */
const sessionSecret = args.rotate && !args['rotate-session']
  ? (envValue(existing, 'ADMIN_SESSION_SECRET') ?? randomBytes(32).toString('hex'))
  : randomBytes(32).toString('hex')

// ⚠️ Belt and braces after the Compose interpolation incident: if a generated
// value ever contains `$`, say so here rather than letting it be silently
// truncated on its way into the container.
//
// ⚠️ This check used to run BEFORE totpSecret and sessionSecret existed and was
// passed empty strings for both, so it only ever examined the hash. Moved below
// the generation so it checks what it claims to.
for (const [name, value] of Object.entries({ hash, totpSecret, sessionSecret })) {
  if (value.includes('$')) {
    console.error(`Generated ${name} contains "$", which docker compose would mangle in deploy/.env.`)
    process.exit(3)
  }
}

/**
 * Render the otpauth URI as a QR in the terminal.
 *
 * ⚠️ Drawn LOCALLY, never through an image service. A
 * `chart.googleapis.com`-style URL would send the TOTP secret — half the admin
 * credential — to a third party in a query string, where it would sit in their
 * request logs. That is a strange thing to do while rotating a credential
 * because you are worried about exposure.
 *
 * ⚠️ Never throws. If the terminal cannot render it, the URI below is still the
 * authoritative thing to enter by hand; losing the picture must not lose the
 * secret.
 */
async function printQr(uri: string): Promise<void> {
  try {
    const mod = await import('qrcode-terminal')
    // ⚠️ Called as a METHOD, not destructured. qrcode-terminal's generate()
    // reads `this.error_level`, so pulling the function off the object gives
    // `bad rs block @ errorCorrectLevel:undefined` — a failure that looks like
    // a bad payload rather than a lost receiver.
    const qr = ((mod as { default?: unknown }).default ?? mod) as {
      generate(text: string, opts: { small: boolean }): void
    }
    if (typeof qr.generate !== 'function') throw new Error('no generate()')
    qr.generate(uri, { small: true })
  } catch (err) {
    console.log(`  (could not draw a QR here: ${err instanceof Error ? err.message : String(err)})`)
  }
}

const lines = {
  ADMIN_USERNAME: username,
  ADMIN_PASSWORD_HASH: hash,
  ADMIN_TOTP_SECRET: totpSecret,
  ADMIN_SESSION_SECRET: sessionSecret,
}

if (args.rotate) {
  writeEnv(envPath, setEnvValues(existing, lines))
  console.log(`
Rewrote ${envPath} in place:

  ADMIN_USERNAME         ${username}
  ADMIN_PASSWORD_HASH    (new)
  ADMIN_TOTP_SECRET      ${keepTotp ? 'unchanged — your authenticator still works' : '(new — rescan below)'}
  ADMIN_SESSION_SECRET   ${args['rotate-session'] ? '(new — every live admin session is now invalid)' : 'unchanged'}

⚠️ Comments, ordering and every other key were preserved, and the file was
written via a temp file and renamed — deploy/.env holds every faction's database
password, and a half-written one is not recoverable from git.

Apply it:
  docker compose --profile admin -f deploy/docker-compose.yml \
    -f deploy/docker-compose.override.yml --project-directory deploy up -d admin
`)
} else {
  console.log(`
Add these to deploy/.env:

${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}

⚠️ ADMIN_SESSION_SECRET must NOT equal JWT_SECRET — the container refuses to
start if it does, because sharing it would make every tenant session token a
valid admin credential.

Next time, \`--rotate\` edits deploy/.env in place instead.
`)
}

if (keepTotp) {
  console.log('Your authenticator entry is unchanged — nothing to rescan.\n')
} else {
  console.log('Scan this into your authenticator app (Aegis, 1Password, Google Authenticator):\n')
  await printQr(totpUri(totpSecret, username))
  console.log(`
Or enter it by hand:  ${totpUri(totpSecret, username)}

⚠️ Check the app shows a code BEFORE you rely on it — a mistyped secret is only
discoverable at login, when you are already locked out.
`)
}
